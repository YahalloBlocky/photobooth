// =========================================================
// Whole-strip photo editor.
//
// Two modes:
//   'strip' - room.js: editing the full photo strip (frame + all shots
//             together). Each shot can be individually repositioned.
//   'flat'  - admin.js: editing a single already-flattened saved photo.
//
// Architecture: a base layer (frame + photos, or single image) is drawn
// fresh every render. A SEPARATE offscreen ink canvas holds only pen
// strokes -- erasing works only within that layer, so it can never eat
// into the photo or frame underneath. Text/photo objects are drawn on
// top of everything and are individually selectable, movable, resizable,
// and deletable.
// =========================================================

const PhotoEditor = (() => {
  let overlay, canvas, ctx, inkCanvas, inkCtx;
  let mode = 'strip';
  let width = 0, height = 0;

  // 'flat' mode
  let flatImg = null;
  let flatCrop = { x: 0, y: 0, w: 0, h: 0 };

  // 'strip' mode
  let shotImgs = [];      // Image objects, one per shot
  let shotRects = [];     // {x,y,w,h} slot for each shot within the strip
  let shotCrops = [];     // {x,y,w,h} source crop window per shot
  let frameRenderer = null;
  let customFrameImg = null;

  let actions = [];       // ink strokes: {type:'stroke'|'erase', color, size, points[]}
  let objects = [];       // {id,type:'text'|'image', x,y,w,h,text,font,color,img?}
  let selectedId = null;
  let nextObjectId = 1;

  let currentTool = 'move';
  let currentColor = '#a5502e';
  let currentSize = 6;
  let currentFont = "'Work Sans', sans-serif";

  let undoStack = [];
  let redoStack = [];

  let dragMode = null; // 'crop' | 'object-move' | 'object-resize' | 'stroke'
  let dragTarget = null;
  let dragStart = null;
  let cropStartVal = null;

  let onSaveCb = null;
  let textEditEl = null;

  function ensureDom() {
    overlay = document.getElementById('editorOverlay');
    canvas = document.getElementById('editorCanvas');
    ctx = canvas.getContext('2d');
    inkCanvas = document.getElementById('inkLayerCanvas') || document.createElement('canvas');
    inkCtx = inkCanvas.getContext('2d');
  }

  function snapshot() {
    return JSON.stringify({
      shotCrops,
      actions,
      objects: objects.map(o => ({ ...o, img: undefined, imgSrc: o.img ? o.img.src : undefined })),
      flatCrop,
      customFrameSrc: customFrameImg ? customFrameImg.src : null
    });
  }

  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > 40) undoStack.shift();
    redoStack = [];
  }

  function restore(snapStr) {
    const s = JSON.parse(snapStr);
    shotCrops = s.shotCrops || shotCrops;
    actions = s.actions || [];
    flatCrop = s.flatCrop || flatCrop;

    const finish = () => {
      renderInkLayer();
      render();
      updateContextControls();
    };

    const applyFrame = () => {
      if (s.customFrameSrc) {
        const cf = new Image();
        cf.onload = () => { customFrameImg = cf; finish(); };
        cf.src = s.customFrameSrc;
      } else {
        customFrameImg = null;
        finish();
      }
    };

    const imageObjs = s.objects.filter(o => o.type === 'image' && o.imgSrc);
    if (imageObjs.length === 0) {
      objects = s.objects.map(o => ({ ...o }));
      selectedId = null;
      applyFrame();
    } else {
      const cache = {};
      let remaining = imageObjs.length;
      imageObjs.forEach(o => {
        const img = new Image();
        img.onload = () => {
          cache[o.imgSrc] = img;
          if (--remaining === 0) {
            objects = s.objects.map(o2 => o2.type === 'image' ? { ...o2, img: cache[o2.imgSrc] } : { ...o2 });
            selectedId = null;
            applyFrame();
          }
        };
        img.src = o.imgSrc;
      });
    }
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }

  function computeCoverCrop(srcW, srcH, destW, destH) {
    const srcAspect = srcW / srcH;
    const destAspect = destW / destH;
    let sx, sy, sw, sh;
    if (srcAspect > destAspect) {
      sh = srcH; sw = srcH * destAspect; sx = (srcW - sw) / 2; sy = 0;
    } else {
      sw = srcW; sh = srcW / destAspect; sx = 0; sy = (srcH - sh) / 2;
    }
    return { x: sx, y: sy, w: sw, h: sh };
  }

  function clampCrop(crop, img) {
    crop.x = Math.max(0, Math.min(img.naturalWidth - crop.w, crop.x));
    crop.y = Math.max(0, Math.min(img.naturalHeight - crop.h, crop.y));
  }

  function renderInkLayer() {
    inkCanvas.width = width;
    inkCanvas.height = height;
    inkCtx.clearRect(0, 0, width, height);
    actions.forEach(a => {
      inkCtx.save();
      inkCtx.globalCompositeOperation = a.type === 'erase' ? 'destination-out' : 'source-over';
      inkCtx.strokeStyle = a.color;
      inkCtx.lineWidth = a.size;
      inkCtx.lineCap = 'round';
      inkCtx.lineJoin = 'round';
      inkCtx.beginPath();
      a.points.forEach((p, i) => { if (i === 0) inkCtx.moveTo(p.x, p.y); else inkCtx.lineTo(p.x, p.y); });
      inkCtx.stroke();
      inkCtx.restore();
    });
  }

  function objectBounds(o) {
    if (o.type === 'text') {
      ctx.font = `600 ${o.h}px ${o.font}`;
      const w = Math.max(20, ctx.measureText(o.text).width);
      return { x: o.x, y: o.y, w, h: o.h };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  function render() {
    ctx.clearRect(0, 0, width, height);

    if (mode === 'flat') {
      if (flatImg) ctx.drawImage(flatImg, flatCrop.x, flatCrop.y, flatCrop.w, flatCrop.h, 0, 0, width, height);
    } else {
      if (customFrameImg) {
        ctx.drawImage(customFrameImg, 0, 0, width, height);
      } else if (frameRenderer) {
        frameRenderer(ctx, width, height);
      }
      shotImgs.forEach((img, i) => {
        if (!img) return;
        const rect = shotRects[i];
        const crop = shotCrops[i];
        ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, rect.x, rect.y, rect.w, rect.h);
      });
    }

    ctx.drawImage(inkCanvas, 0, 0);

    objects.forEach(o => {
      ctx.save();
      if (o.type === 'text') {
        ctx.fillStyle = o.color;
        ctx.font = `600 ${o.h}px ${o.font}`;
        ctx.textBaseline = 'top';
        ctx.fillText(o.text, o.x, o.y);
      } else if (o.type === 'image' && o.img) {
        ctx.drawImage(o.img, o.x, o.y, o.w, o.h);
      }
      ctx.restore();

      if (o.id === selectedId) {
        const b = objectBounds(o);
        ctx.save();
        ctx.strokeStyle = '#A5502E';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#A5502E';
        ctx.fillRect(b.x + b.w - 8, b.y + b.h - 8, 16, 16);
        ctx.restore();
      }
    });
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function hitTestObject(pos) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      const b = objectBounds(o);
      if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
        const onHandle = pos.x >= b.x + b.w - 16 && pos.y >= b.y + b.h - 16;
        return { obj: o, onHandle, bounds: b };
      }
    }
    return null;
  }

  function hitTestShot(pos) {
    for (let i = 0; i < shotRects.length; i++) {
      const r = shotRects[i];
      if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) return i;
    }
    return -1;
  }

  function onPointerDown(e) {
    e.preventDefault();
    const pos = getPos(e);

    const hit = hitTestObject(pos);
    if (hit) {
      selectedId = hit.obj.id;
      updateContextControls();
      pushHistory();
      dragMode = hit.onHandle ? 'object-resize' : 'object-move';
      dragTarget = hit.obj;
      dragStart = pos;
      render();
      return;
    }

    if (selectedId !== null) {
      selectedId = null;
      updateContextControls();
      render();
    }

    if (currentTool === 'draw' || currentTool === 'erase') {
      pushHistory();
      const stroke = { type: currentTool === 'erase' ? 'erase' : 'stroke', color: currentColor, size: currentSize, points: [pos] };
      actions.push(stroke);
      dragMode = 'stroke';
      dragTarget = stroke;
      renderInkLayer();
      render();
      return;
    }

    if (currentTool === 'move') {
      if (mode === 'flat') {
        pushHistory();
        dragMode = 'crop';
        dragTarget = flatCrop;
        dragStart = pos;
        cropStartVal = { x: flatCrop.x, y: flatCrop.y };
        return;
      }
      const shotIndex = hitTestShot(pos);
      if (shotIndex >= 0) {
        pushHistory();
        dragMode = 'crop';
        dragTarget = shotCrops[shotIndex];
        dragStart = pos;
        cropStartVal = { x: shotCrops[shotIndex].x, y: shotCrops[shotIndex].y };
        dragTarget._shotIndex = shotIndex;
      }
    }
  }

  function onPointerMove(e) {
    if (!dragMode) return;
    e.preventDefault();
    const pos = getPos(e);

    if (dragMode === 'stroke') {
      dragTarget.points.push(pos);
      renderInkLayer();
      render();
      return;
    }
    if (dragMode === 'object-move') {
      dragTarget.x += pos.x - dragStart.x;
      dragTarget.y += pos.y - dragStart.y;
      dragStart = pos;
      render();
      return;
    }
    if (dragMode === 'object-resize') {
      const dx = pos.x - dragStart.x, dy = pos.y - dragStart.y;
      if (dragTarget.type === 'image') {
        dragTarget.w = Math.max(20, dragTarget.w + dx);
        dragTarget.h = Math.max(20, dragTarget.h + dy);
      } else {
        dragTarget.h = Math.max(12, dragTarget.h + dy);
      }
      dragStart = pos;
      render();
      return;
    }
    if (dragMode === 'crop') {
      const dx = pos.x - dragStart.x, dy = pos.y - dragStart.y;
      const destW = mode === 'flat' ? width : shotRects[dragTarget._shotIndex].w;
      const scale = dragTarget.w / destW;
      dragTarget.x = cropStartVal.x - dx * scale;
      dragTarget.y = cropStartVal.y - dy * scale;
      const img = mode === 'flat' ? flatImg : shotImgs[dragTarget._shotIndex];
      clampCrop(dragTarget, img);
      render();
    }
  }

  function onPointerUp() {
    dragMode = null;
    dragTarget = null;
    dragStart = null;
  }

  function selectTool(tool) {
    currentTool = tool;
    document.querySelectorAll('#editorToolbar .tool-btn[data-tool]').forEach(b => {
      b.classList.toggle('selected', b.dataset.tool === tool);
    });
    if (tool === 'text') { addTextObject(); selectTool('move'); return; }
    if (tool === 'photo') { triggerPhotoUpload(); selectTool('move'); return; }
    updateContextControls();
  }

  function addTextObject() {
    pushHistory();
    const obj = { id: nextObjectId++, type: 'text', x: width / 2 - 60, y: height / 2 - 14, h: 28, text: 'Double-click to edit', color: currentColor, font: currentFont };
    objects.push(obj);
    selectedId = obj.id;
    render();
    updateContextControls();
  }

  function triggerPhotoUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          pushHistory();
          const maxDim = 150;
          const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
          const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
          const obj = { id: nextObjectId++, type: 'image', x: width / 2 - w / 2, y: height / 2 - h / 2, w, h, img };
          objects.push(obj);
          selectedId = obj.id;
          render();
          updateContextControls();
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  function startTextEdit(obj) {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width;
    if (textEditEl) textEditEl.remove();
    textEditEl = document.createElement('textarea');
    textEditEl.value = obj.text;
    textEditEl.style.cssText = `position: fixed; left:${rect.left + obj.x * scale}px; top:${rect.top + obj.y * scale}px; font: 600 ${obj.h * scale}px ${obj.font}; color:${obj.color}; border:1px dashed #A5502E; background: rgba(255,255,255,0.9); z-index: 300; padding:2px; min-width: 80px; resize: both;`;
    document.body.appendChild(textEditEl);
    textEditEl.focus();
    textEditEl.select();
    const finish = () => {
      obj.text = textEditEl.value || obj.text;
      if (textEditEl) { textEditEl.remove(); textEditEl = null; }
      render();
    };
    textEditEl.addEventListener('blur', finish);
    textEditEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textEditEl.blur(); } });
  }

  function deleteSelected() {
    if (selectedId === null) return;
    pushHistory();
    objects = objects.filter(o => o.id !== selectedId);
    selectedId = null;
    render();
    updateContextControls();
  }

  function updateContextControls() {
    const deleteBtn = document.getElementById('editorDeleteBtn');
    const fontWrap = document.getElementById('editorFontWrap');
    const selectedObj = objects.find(o => o.id === selectedId);

    deleteBtn.style.display = selectedObj ? 'inline-flex' : 'none';
    fontWrap.style.display = (selectedObj && selectedObj.type === 'text') ? 'inline-flex' : 'none';

    if (selectedObj && selectedObj.type === 'text') {
      document.getElementById('editorColor').value = selectedObj.color;
      document.getElementById('editorFont').value = selectedObj.font;
    }
  }

  function wireOnce() {
    if (wireOnce._done) return;
    wireOnce._done = true;

    document.getElementById('editorToolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('.tool-btn[data-tool]');
      if (btn) selectTool(btn.dataset.tool);
    });

    document.getElementById('editorColor').addEventListener('input', (e) => {
      currentColor = e.target.value;
      const sel = objects.find(o => o.id === selectedId);
      if (sel && sel.type === 'text') { pushHistory(); sel.color = currentColor; render(); }
    });
    document.getElementById('editorSize').addEventListener('input', (e) => {
      currentSize = Number(e.target.value);
      const sel = objects.find(o => o.id === selectedId);
      if (sel && sel.type === 'text') { pushHistory(); sel.h = Math.max(12, currentSize * 3); render(); }
    });
    document.getElementById('editorFont').addEventListener('change', (e) => {
      currentFont = e.target.value;
      const sel = objects.find(o => o.id === selectedId);
      if (sel && sel.type === 'text') { pushHistory(); sel.font = currentFont; render(); }
    });

    document.getElementById('editorDeleteBtn').addEventListener('click', deleteSelected);
    document.getElementById('editorUndoBtn').addEventListener('click', undo);
    document.getElementById('editorRedoBtn').addEventListener('click', redo);
    document.getElementById('editorResetBtn').addEventListener('click', async () => {
      const ok = await UIDialog.confirm('Reset all edits on this frame? This clears drawings, text, images, and repositioning.');
      if (ok) resetAll();
    });

    document.getElementById('editorFrameUpload').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file || mode !== 'strip') return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => { pushHistory(); customFrameImg = img; render(); };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('editorCancelBtn').addEventListener('click', close);
    document.getElementById('editorSaveBtn').addEventListener('click', () => {
      render();
      const dataUrl = canvas.toDataURL('image/png');
      if (onSaveCb) {
        onSaveCb({
          dataUrl,
          state: mode === 'strip' ? {
            shotCrops: JSON.parse(JSON.stringify(shotCrops)),
            actions: JSON.parse(JSON.stringify(actions)),
            objects: objects.map(o => o.type === 'image' ? { ...o, img: undefined, imgSrc: o.img.src } : { ...o }),
            customFrameSrc: customFrameImg ? customFrameImg.src : null
          } : null
        });
      }
      close();
    });

    canvas.addEventListener('dblclick', (e) => {
      const pos = getPos(e);
      const hit = hitTestObject(pos);
      if (hit && hit.obj.type === 'text') startTextEdit(hit.obj);
    });

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function resetAll() {
    if (mode === 'strip') {
      shotCrops = shotImgs.map((img, i) => computeCoverCrop(img.naturalWidth, img.naturalHeight, shotRects[i].w, shotRects[i].h));
      customFrameImg = null;
    } else {
      flatCrop = computeCoverCrop(flatImg.naturalWidth, flatImg.naturalHeight, width, height);
    }
    actions = [];
    objects = [];
    selectedId = null;
    undoStack = [];
    redoStack = [];
    renderInkLayer();
    render();
    updateContextControls();
  }

  function openFlat({ imageSrc, width: w, height: h, onSave }) {
    ensureDom();
    wireOnce();
    mode = 'flat';
    width = w; height = h;
    canvas.width = w; canvas.height = h;
    actions = []; objects = []; selectedId = null;
    undoStack = []; redoStack = [];
    onSaveCb = onSave;

    document.getElementById('editorFrameUploadLabel').style.display = 'none';
    selectTool('move');
    currentColor = document.getElementById('editorColor').value;
    currentSize = Number(document.getElementById('editorSize').value);

    const img = new Image();
    img.onload = () => {
      flatImg = img;
      flatCrop = computeCoverCrop(img.naturalWidth, img.naturalHeight, w, h);
      renderInkLayer();
      render();
      updateContextControls();
    };
    img.src = imageSrc;

    overlay.classList.add('open');
  }

  function openStrip({ shots, shotRects: rects, width: w, height: h, frameRenderer: fr, initialState, onSave }) {
    ensureDom();
    wireOnce();
    mode = 'strip';
    width = w; height = h;
    canvas.width = w; canvas.height = h;
    shotRects = rects;
    frameRenderer = fr;
    onSaveCb = onSave;
    selectedId = null;
    undoStack = []; redoStack = [];

    actions = initialState ? JSON.parse(JSON.stringify(initialState.actions || [])) : [];
    const restoredObjMeta = initialState ? (initialState.objects || []) : [];
    customFrameImg = null;

    document.getElementById('editorFrameUploadLabel').style.display = 'inline-flex';
    selectTool('move');
    currentColor = document.getElementById('editorColor').value;
    currentSize = Number(document.getElementById('editorSize').value);

    let loaded = 0;
    shotImgs = shots.map(() => null);
    shotCrops = shots.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));

    shots.forEach((src, i) => {
      const img = new Image();
      img.onload = () => {
        shotImgs[i] = img;
        shotCrops[i] = (initialState && initialState.shotCrops && initialState.shotCrops[i])
          ? initialState.shotCrops[i]
          : computeCoverCrop(img.naturalWidth, img.naturalHeight, rects[i].w, rects[i].h);
        loaded++;
        if (loaded === shots.length) finishOpenStrip(restoredObjMeta, initialState);
      };
      img.src = src;
    });
  }

  function finishOpenStrip(restoredObjMeta, initialState) {
    const imageObjs = restoredObjMeta.filter(o => o.type === 'image' && o.imgSrc);

    const applyObjects = (imgCache) => {
      objects = restoredObjMeta.map(o => o.type === 'image' ? { ...o, img: imgCache[o.imgSrc] } : { ...o });

      const afterFrame = () => { renderInkLayer(); render(); updateContextControls(); overlay.classList.add('open'); };

      if (initialState && initialState.customFrameSrc) {
        const cf = new Image();
        cf.onload = () => { customFrameImg = cf; afterFrame(); };
        cf.src = initialState.customFrameSrc;
      } else {
        afterFrame();
      }
    };

    if (imageObjs.length === 0) {
      applyObjects({});
    } else {
      const cache = {};
      let remaining = imageObjs.length;
      imageObjs.forEach(o => {
        const img = new Image();
        img.onload = () => { cache[o.imgSrc] = img; if (--remaining === 0) applyObjects(cache); };
        img.src = o.imgSrc;
      });
    }
  }

  function close() {
    overlay.classList.remove('open');
    if (textEditEl) { textEditEl.remove(); textEditEl = null; }
  }

  return { openFlat, openStrip, close };
})();

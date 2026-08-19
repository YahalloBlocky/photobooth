// =========================================================
// Whole-strip photo editor.
//
// 'strip' mode (room.js): frame + every shot, where each shot is made of
// one or more independent "layers" (one per participant). Shots can be
// freely repositioned (Move), and each person's own layer within a shot
// can be independently cropped/rotated/flipped (Crop).
//
// 'flat' mode (admin.js): a single already-flattened saved photo, with
// pan/crop/rotate/flip on the whole image.
//
// Ink strokes live on a separate offscreen layer -- erasing only ever
// removes ink, never the photo or frame underneath.
// =========================================================

const PhotoEditor = (() => {
  let overlay, canvas, ctx, inkCanvas, inkCtx;
  let mode = 'strip';
  let width = 0, height = 0;

  // 'flat' mode
  let flatImg = null;
  let flatCrop = { x: 0, y: 0, w: 0, h: 0, rotation: 0, flipX: false };

  // 'strip' mode
  let shots = [];              // [{ layers: [{ img }, ...] }]
  let defaultShotSize = { w: 0, h: 0 };
  let shotSizes = [];          // [{w,h}] -- mutable, one per shot (Resize tool)
  let shotPositions = [];      // [{x,y}] -- mutable, one per shot
  let layerCrops = [];         // [[{x,y,w,h,rotation,flipX}]] -- [shotIdx][layerIdx]
  let frameRenderer = null;
  let customFrameImg = null;
  let activeLayerRef = null;   // {shotIdx, layerIdx} -- last touched via Crop tool

  let actions = [];
  let objects = [];
  let selectedId = null;
  let nextObjectId = 1;

  let currentTool = 'move';
  let currentColor = '#a5502e';
  let currentSize = 6;
  let currentFont = "'Work Sans', sans-serif";

  let undoStack = [];
  let redoStack = [];

  let dragMode = null; // 'shot' | 'shot-resize' | 'layer-crop' | 'flat-crop' | 'object-move' | 'object-resize' | 'stroke'
  let dragTarget = null;
  let dragStart = null;
  let dragStartVal = null;
  let resizingShotIdx = null;

  let onSaveCb = null;
  let textEditEl = null;
  let lastScaleX = 1; // canvas units per CSS px, used to size touch targets sensibly

  function ensureDom() {
    overlay = document.getElementById('editorOverlay');
    canvas = document.getElementById('editorCanvas');
    ctx = canvas.getContext('2d');
    inkCanvas = document.getElementById('inkLayerCanvas') || document.createElement('canvas');
    inkCtx = inkCanvas.getContext('2d');
  }

  // ---------- History ----------
  function snapshot() {
    return JSON.stringify({
      shotPositions,
      shotSizes,
      layerCrops,
      actions,
      objects: objects.map(o => ({ ...o, img: undefined, imgSrc: o.img ? o.img.src : undefined })),
      flatCrop,
      customFrameSrc: customFrameImg ? customFrameImg.src : null
    });
  }

  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
  }

  function restore(snapStr) {
    const s = JSON.parse(snapStr);
    shotPositions = s.shotPositions || shotPositions;
    shotSizes = s.shotSizes || shotSizes;
    layerCrops = s.layerCrops || layerCrops;
    actions = s.actions || [];
    flatCrop = s.flatCrop || flatCrop;

    const finish = () => { renderInkLayer(); render(); updateContextControls(); };

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

  // ---------- Geometry helpers ----------
  function computeCoverCrop(srcW, srcH, destW, destH) {
    const srcAspect = srcW / srcH;
    const destAspect = destW / destH;
    let sx, sy, sw, sh;
    if (srcAspect > destAspect) {
      sh = srcH; sw = srcH * destAspect; sx = (srcW - sw) / 2; sy = 0;
    } else {
      sw = srcW; sh = srcW / destAspect; sx = 0; sy = (srcH - sh) / 2;
    }
    return { x: sx, y: sy, w: sw, h: sh, rotation: 0, flipX: false, baseW: sw, baseH: sh };
  }

  function clampCrop(crop, img) {
    crop.x = Math.max(0, Math.min(img.naturalWidth - crop.w, crop.x));
    crop.y = Math.max(0, Math.min(img.naturalHeight - crop.h, crop.y));
  }

  function layerRectsForShot(shotX, shotY, sizeW, sizeH, layerCount) {
    const rects = [];
    const w = sizeW / Math.max(1, layerCount);
    for (let j = 0; j < layerCount; j++) rects.push({ x: shotX + w * j, y: shotY, w, h: sizeH });
    return rects;
  }

  function shotBounds(shotIdx) {
    const pos = shotPositions[shotIdx];
    const size = shotSizes[shotIdx];
    return { x: pos.x, y: pos.y, w: size.w, h: size.h };
  }

  // ---------- Rendering ----------
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

  function drawTransformed(img, crop, destRect) {
    const rotation = crop.rotation || 0;
    const flipX = !!crop.flipX;
    ctx.save();
    ctx.translate(destRect.x + destRect.w / 2, destRect.y + destRect.h / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    if (flipX) ctx.scale(-1, 1);
    const swapped = rotation === 90 || rotation === 270;
    const drawW = swapped ? destRect.h : destRect.w;
    const drawH = swapped ? destRect.w : destRect.h;
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  function textBounds(o) {
    ctx.font = `600 ${o.h}px ${o.font}`;
    const m = ctx.measureText(o.text);
    const w = Math.max(24, m.width);
    return { x: o.x - 6, y: o.y - 4, w: w + 12, h: o.h + 10 };
  }

  function objectBounds(o) {
    return o.type === 'text' ? textBounds(o) : { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  function render() {
    ctx.clearRect(0, 0, width, height);

    if (mode === 'flat') {
      if (flatImg) drawTransformed(flatImg, flatCrop, { x: 0, y: 0, w: width, h: height });
    } else {
      if (customFrameImg) {
        ctx.drawImage(customFrameImg, 0, 0, width, height);
      } else if (frameRenderer) {
        frameRenderer(ctx, width, height);
      }

      shots.forEach((shot, i) => {
        const pos = shotPositions[i];
        const size = shotSizes[i];
        const rects = layerRectsForShot(pos.x, pos.y, size.w, size.h, shot.layers.length);
        shot.layers.forEach((layer, j) => {
          if (!layer.img) return;
          drawTransformed(layer.img, layerCrops[i][j], rects[j]);
        });

        if (currentTool === 'move') {
          const b = shotBounds(i);
          ctx.save();
          ctx.strokeStyle = 'rgba(165,80,46,0.55)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.setLineDash([]);
          ctx.restore();
        }
        if (currentTool === 'resize') {
          const b = shotBounds(i);
          ctx.save();
          ctx.strokeStyle = '#A5502E';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.setLineDash([]);
          const hs = handleSize();
          ctx.fillStyle = '#A5502E';
          ctx.beginPath();
          ctx.arc(b.x + b.w, b.y + b.h, hs / 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }
        if (currentTool === 'crop' && activeLayerRef && activeLayerRef.shotIdx === i) {
          const r = rects[activeLayerRef.layerIdx];
          ctx.save();
          ctx.strokeStyle = '#A5502E';
          ctx.lineWidth = 2;
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          ctx.restore();
        }
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
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.setLineDash([]);
        const hs = handleSize();
        ctx.fillStyle = '#A5502E';
        ctx.beginPath();
        ctx.arc(b.x + b.w, b.y + b.h, hs / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  // Keeps touch targets a usable size (~34 CSS px) regardless of how much
  // the canvas is scaled down to fit the screen.
  function handleSize() {
    return Math.max(18, 34 * lastScaleX);
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    lastScaleX = scaleX;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function hitTestObject(pos) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      const b = objectBounds(o);
      const hs = handleSize();
      const nearHandle = Math.hypot(pos.x - (b.x + b.w), pos.y - (b.y + b.h)) <= hs;
      if (nearHandle) return { obj: o, onHandle: true, bounds: b };
      if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
        return { obj: o, onHandle: false, bounds: b };
      }
    }
    return null;
  }

  function hitTestShot(pos) {
    for (let i = 0; i < shotPositions.length; i++) {
      const b = shotBounds(i);
      if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) return i;
    }
    return -1;
  }

  function hitTestShotHandle(pos) {
    const hs = handleSize();
    for (let i = 0; i < shotPositions.length; i++) {
      const b = shotBounds(i);
      if (Math.hypot(pos.x - (b.x + b.w), pos.y - (b.y + b.h)) <= hs) return i;
    }
    return -1;
  }

  function hitTestLayer(pos) {
    for (let i = 0; i < shots.length; i++) {
      const pos_i = shotPositions[i];
      const size_i = shotSizes[i];
      const rects = layerRectsForShot(pos_i.x, pos_i.y, size_i.w, size_i.h, shots[i].layers.length);
      for (let j = 0; j < rects.length; j++) {
        const r = rects[j];
        if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
          return { shotIdx: i, layerIdx: j };
        }
      }
    }
    return null;
  }

  // ---------- Pointer handling ----------
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

    if (selectedId !== null) { selectedId = null; updateContextControls(); render(); }

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

    if (mode === 'flat' && currentTool === 'move') {
      pushHistory();
      dragMode = 'flat-crop';
      dragTarget = flatCrop;
      dragStart = pos;
      dragStartVal = { x: flatCrop.x, y: flatCrop.y };
      return;
    }

    if (mode === 'strip' && currentTool === 'move') {
      const shotIdx = hitTestShot(pos);
      if (shotIdx >= 0) {
        pushHistory();
        dragMode = 'shot';
        dragTarget = shotPositions[shotIdx];
        dragStart = pos;
        dragStartVal = { x: shotPositions[shotIdx].x, y: shotPositions[shotIdx].y };
      }
      return;
    }

    if (mode === 'strip' && currentTool === 'resize') {
      const handleIdx = hitTestShotHandle(pos);
      if (handleIdx >= 0) {
        pushHistory();
        dragMode = 'shot-resize';
        dragTarget = shotSizes[handleIdx];
        resizingShotIdx = handleIdx;
        dragStart = pos;
        return;
      }
      const shotIdx = hitTestShot(pos);
      if (shotIdx >= 0) {
        pushHistory();
        dragMode = 'shot-resize';
        dragTarget = shotSizes[shotIdx];
        resizingShotIdx = shotIdx;
        dragStart = pos;
      }
      return;
    }

    if (mode === 'strip' && currentTool === 'crop') {
      const hitLayer = hitTestLayer(pos);
      if (hitLayer) {
        activeLayerRef = hitLayer;
        updateContextControls();
        pushHistory();
        const crop = layerCrops[hitLayer.shotIdx][hitLayer.layerIdx];
        dragMode = 'layer-crop';
        dragTarget = crop;
        dragTarget._shotIdx = hitLayer.shotIdx;
        dragTarget._layerIdx = hitLayer.layerIdx;
        dragStart = pos;
        dragStartVal = { x: crop.x, y: crop.y };
        render();
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
        // Preserve the image's own aspect ratio -- drive the resize off
        // whichever axis moved more, deriving the other from that ratio,
        // instead of letting w/h drift independently (which stretches it).
        const aspect = dragTarget.img ? dragTarget.img.naturalWidth / dragTarget.img.naturalHeight : dragTarget.w / dragTarget.h;
        const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy * aspect;
        dragTarget.w = Math.max(24, dragTarget.w + delta);
        dragTarget.h = Math.max(24 / aspect, dragTarget.w / aspect);
      } else {
        const diag = Math.hypot(dx, dy) * (dx + dy >= 0 ? 1 : -1);
        dragTarget.h = Math.max(12, dragTarget.h + diag * 0.5);
      }
      dragStart = pos;
      render();
      return;
    }
    if (dragMode === 'shot') {
      dragTarget.x = dragStartVal.x + (pos.x - dragStart.x);
      dragTarget.y = dragStartVal.y + (pos.y - dragStart.y);
      render();
      return
    }
    if (dragMode === 'shot-resize') {
      const dx = pos.x - dragStart.x, dy = pos.y - dragStart.y;
      dragTarget.w = Math.max(60, dragTarget.w + dx);
      dragTarget.h = Math.max(60, dragTarget.h + dy);
      dragStart = pos;
      render();
      return;
    }
    if (dragMode === 'flat-crop' || dragMode === 'layer-crop') {
      const dx = pos.x - dragStart.x, dy = pos.y - dragStart.y;
      const destW = dragMode === 'flat-crop' ? width : shotSizes[dragTarget._shotIdx].w / shots[dragTarget._shotIdx].layers.length;
      const scale = dragTarget.w / destW;
      dragTarget.x = dragStartVal.x - dx * scale;
      dragTarget.y = dragStartVal.y - dy * scale;
      const img = dragMode === 'flat-crop' ? flatImg : shots[dragTarget._shotIdx].layers[dragTarget._layerIdx].img;
      clampCrop(dragTarget, img);
      render();
    }
  }

  function onPointerUp() {
    if (dragMode === 'shot-resize' && resizingShotIdx !== null) {
      const shot = shots[resizingShotIdx];
      const size = shotSizes[resizingShotIdx];
      const pos = shotPositions[resizingShotIdx];
      const rects = layerRectsForShot(pos.x, pos.y, size.w, size.h, shot.layers.length);
      shot.layers.forEach((layer, j) => {
        if (!layer.img) return;
        layerCrops[resizingShotIdx][j] = computeCoverCrop(layer.img.naturalWidth, layer.img.naturalHeight, rects[j].w, rects[j].h);
      });
      resizingShotIdx = null;
      render();
    }
    dragMode = null;
    dragTarget = null;
    dragStart = null;
    dragStartVal = null;
  }

  // ---------- Tools ----------
  function selectTool(tool) {
    currentTool = tool;
    document.querySelectorAll('#editorToolbar .tool-btn[data-tool]').forEach(b => {
      b.classList.toggle('selected', b.dataset.tool === tool);
    });
    if (tool === 'text') { addTextObject(); selectTool('move'); return; }
    if (tool === 'photo') { triggerPhotoUpload(); selectTool('move'); return; }
    if (tool === 'crop' && mode === 'strip' && !activeLayerRef && shots.length) {
      activeLayerRef = { shotIdx: 0, layerIdx: 0 };
    }
    updateContextControls();
    render();
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
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    if (textEditEl) textEditEl.remove();
    textEditEl = document.createElement('textarea');
    textEditEl.value = obj.text;
    textEditEl.spellcheck = false;
    textEditEl.style.cssText = `position: fixed; left:${rect.left + obj.x * scaleX}px; top:${rect.top + obj.y * scaleY}px; font: 600 ${obj.h * scaleY}px ${obj.font}; color:${obj.color}; border:2px solid #A5502E; border-radius:6px; background: rgba(255,255,255,0.95); z-index: 300; padding:4px 6px; min-width: 100px; resize: both; line-height:1.2;`;
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

  function rotateActiveLayer() {
    const crop = mode === 'flat' ? flatCrop : (activeLayerRef && layerCrops[activeLayerRef.shotIdx][activeLayerRef.layerIdx]);
    if (!crop) return;
    pushHistory();
    crop.rotation = ((crop.rotation || 0) + 90) % 360;
    render();
  }

  function flipActiveLayer() {
    const crop = mode === 'flat' ? flatCrop : (activeLayerRef && layerCrops[activeLayerRef.shotIdx][activeLayerRef.layerIdx]);
    if (!crop) return;
    pushHistory();
    crop.flipX = !crop.flipX;
    render();
  }

  // Actual zoom (not just panning) -- shrinks/grows the crop window around
  // its current center, clamped so it never exceeds the source image.
  function setActiveLayerZoom(zoomPct) {
    const crop = mode === 'flat' ? flatCrop : (activeLayerRef && layerCrops[activeLayerRef.shotIdx][activeLayerRef.layerIdx]);
    if (!crop || !crop.baseW) return;
    const img = mode === 'flat' ? flatImg : (activeLayerRef && shots[activeLayerRef.shotIdx].layers[activeLayerRef.layerIdx].img);
    if (!img) return;

    const factor = Math.max(1, zoomPct / 100);
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    crop.w = crop.baseW / factor;
    crop.h = crop.baseH / factor;
    crop.x = cx - crop.w / 2;
    crop.y = cy - crop.h / 2;
    clampCrop(crop, img);
    render();
  }

  function updateContextControls() {
    const deleteBtn = document.getElementById('editorDeleteBtn');
    const fontWrap = document.getElementById('editorFontWrap');
    const rotateBtn = document.getElementById('editorRotateLayerBtn');
    const flipBtn = document.getElementById('editorFlipLayerBtn');
    const zoomWrap = document.getElementById('editorZoomWrap');
    const zoomSlider = document.getElementById('editorZoom');
    const selectedObj = objects.find(o => o.id === selectedId);

    deleteBtn.style.display = selectedObj ? 'inline-flex' : 'none';
    fontWrap.style.display = (selectedObj && selectedObj.type === 'text') ? 'inline-flex' : 'none';

    const showLayerControls = mode === 'flat' || currentTool === 'crop';
    if (rotateBtn) rotateBtn.style.display = showLayerControls ? 'inline-flex' : 'none';
    if (flipBtn) flipBtn.style.display = showLayerControls ? 'inline-flex' : 'none';
    if (zoomWrap) {
      zoomWrap.style.display = showLayerControls ? 'inline-flex' : 'none';
      if (showLayerControls && zoomSlider) {
        const crop = mode === 'flat' ? flatCrop : (activeLayerRef && layerCrops[activeLayerRef.shotIdx][activeLayerRef.layerIdx]);
        if (crop && crop.baseW) {
          const currentZoom = Math.round((crop.baseW / crop.w) * 100);
          zoomSlider.value = Math.min(300, Math.max(100, currentZoom));
        }
      }
    }

    if (selectedObj && selectedObj.type === 'text') {
      document.getElementById('editorColor').value = selectedObj.color;
      document.getElementById('editorFont').value = selectedObj.font;
    }
  }

  // ---------- Wiring ----------
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

    const rotateBtn = document.getElementById('editorRotateLayerBtn');
    const flipBtn = document.getElementById('editorFlipLayerBtn');
    if (rotateBtn) rotateBtn.addEventListener('click', rotateActiveLayer);
    if (flipBtn) flipBtn.addEventListener('click', flipActiveLayer);

    const zoomSlider = document.getElementById('editorZoom');
    if (zoomSlider) {
      let zoomHistoryPushed = false;
      zoomSlider.addEventListener('input', () => {
        if (!zoomHistoryPushed) { pushHistory(); zoomHistoryPushed = true; }
        setActiveLayerZoom(Number(zoomSlider.value));
      });
      zoomSlider.addEventListener('change', () => { zoomHistoryPushed = false; });
    }

    document.getElementById('editorResetBtn').addEventListener('click', async () => {
      const ok = await UIDialog.confirm('Reset all edits? This clears drawings, text, images, and any repositioning or cropping.');
      if (ok) resetAll();
    });

    const frameUpload = document.getElementById('editorFrameUpload');
    if (frameUpload) {
      frameUpload.addEventListener('change', (e) => {
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
    }

    document.getElementById('editorCancelBtn').addEventListener('click', close);
    document.getElementById('editorSaveBtn').addEventListener('click', () => {
      render();
      const dataUrl = canvas.toDataURL('image/png');
      if (onSaveCb) {
        onSaveCb({
          dataUrl,
          state: mode === 'strip' ? {
            shotPositions: JSON.parse(JSON.stringify(shotPositions)),
            shotSizes: JSON.parse(JSON.stringify(shotSizes)),
            shotCrops: JSON.parse(JSON.stringify(layerCrops)),
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
      shotPositions = shots.map((_, i) => ({ ...defaultPositionsRef[i] }));
      shotSizes = shots.map(() => ({ ...defaultSizeRef }));
      layerCrops = shots.map((shot, i) => shot.layers.map((layer, j) => {
        const rects = layerRectsForShot(defaultPositionsRef[i].x, defaultPositionsRef[i].y, defaultSizeRef.w, defaultSizeRef.h, shot.layers.length);
        return computeCoverCrop(layer.img.naturalWidth, layer.img.naturalHeight, rects[j].w, rects[j].h);
      }));
      customFrameImg = null;
      activeLayerRef = shots.length ? { shotIdx: 0, layerIdx: 0 } : null;
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

  let defaultPositionsRef = [];
  let defaultSizeRef = { w: 0, h: 0 };

  // ---------- Public API ----------
  function openFlat({ imageSrc, width: w, height: h, onSave }) {
    ensureDom();
    wireOnce();
    mode = 'flat';
    width = w; height = h;
    canvas.width = w; canvas.height = h;
    actions = []; objects = []; selectedId = null;
    undoStack = []; redoStack = [];
    onSaveCb = onSave;

    const frameLabel = document.getElementById('editorFrameUploadLabel');
    if (frameLabel) frameLabel.style.display = 'none';

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

    overlay.classList.add('open'); document.body.classList.add('scroll-locked');
  }

  function openStrip({ shots: shotSrcs, defaultShotPositions, defaultShotSize: sSize, width: w, height: h, frameRenderer: fr, initialState, onSave }) {
    ensureDom();
    wireOnce();
    mode = 'strip';
    width = w; height = h;
    canvas.width = w; canvas.height = h;
    defaultSizeRef = sSize;
    defaultPositionsRef = defaultShotPositions;
    frameRenderer = fr;
    onSaveCb = onSave;
    selectedId = null;
    activeLayerRef = null;
    undoStack = []; redoStack = [];

    actions = initialState ? JSON.parse(JSON.stringify(initialState.actions || [])) : [];
    const restoredObjMeta = initialState ? (initialState.objects || []) : [];
    customFrameImg = null;

    const frameLabel = document.getElementById('editorFrameUploadLabel');
    if (frameLabel) frameLabel.style.display = 'inline-flex';

    selectTool('move');
    currentColor = document.getElementById('editorColor').value;
    currentSize = Number(document.getElementById('editorSize').value);

    shotPositions = shotSrcs.map((_, i) => (initialState && initialState.shotPositions && initialState.shotPositions[i]) || { ...defaultShotPositions[i] });
    shotSizes = shotSrcs.map((_, i) => (initialState && initialState.shotSizes && initialState.shotSizes[i]) || { ...sSize });

    shots = shotSrcs.map(s => ({ layers: s.layers.map(() => ({ img: null })) }));
    layerCrops = shotSrcs.map(() => []);

    let totalLayers = 0;
    shotSrcs.forEach(s => { totalLayers += s.layers.length; });
    let loaded = 0;

    if (totalLayers === 0) {
      finishOpenStrip(restoredObjMeta, initialState);
      return;
    }

    shotSrcs.forEach((shot, i) => {
      shot.layers.forEach((layer, j) => {
        const img = new Image();
        img.onload = () => {
          shots[i].layers[j].img = img;
          const rects = layerRectsForShot(shotPositions[i].x, shotPositions[i].y, shotSizes[i].w, shotSizes[i].h, shot.layers.length);
          const restoredCrop = initialState && initialState.shotCrops && initialState.shotCrops[i] && initialState.shotCrops[i][j];
          layerCrops[i][j] = restoredCrop || computeCoverCrop(img.naturalWidth, img.naturalHeight, rects[j].w, rects[j].h);
          loaded++;
          if (loaded === totalLayers) finishOpenStrip(restoredObjMeta, initialState);
        };
        img.src = layer.src;
      });
    });
  }

  function finishOpenStrip(restoredObjMeta, initialState) {
    const imageObjs = restoredObjMeta.filter(o => o.type === 'image' && o.imgSrc);

    const applyObjects = (imgCache) => {
      objects = restoredObjMeta.map(o => o.type === 'image' ? { ...o, img: imgCache[o.imgSrc] } : { ...o });
      activeLayerRef = shots.length ? { shotIdx: 0, layerIdx: 0 } : null;

      const afterFrame = () => { renderInkLayer(); render(); updateContextControls(); overlay.classList.add('open'); document.body.classList.add('scroll-locked'); };

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
    document.body.classList.remove('scroll-locked');
    if (textEditEl) { textEditEl.remove(); textEditEl = null; }
  }

  return { openFlat, openStrip, close };
})();

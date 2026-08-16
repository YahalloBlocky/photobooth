// =========================================================
// A lightweight, reusable photo editor modal.
//
// Usage:
//   PhotoEditor.open({
//     imageSrc: 'data:image/png;base64,...',
//     width: 480, height: 360,
//     onSave: (newDataUrl) => { ... },
//     onRetake: async () => 'data:image/png;base64,...'  // optional
//   });
//
// Internally keeps one ordered list of "actions" (strokes, erases, text,
// stickers) drawn on top of a base image, which can be panned/cropped via
// the Move tool. Everything is flattened into a single PNG on Save.
// =========================================================

const PhotoEditor = (() => {
  const STICKERS = ['🌸', '🍓', '✨', '❤️', '😂', '👍', '🎉', '🌙', '⭐', '🔥'];

  let canvas, ctx, overlay;
  let width, height;
  let baseImg = null;
  let cropX = 0, cropY = 0, cropW = 0, cropH = 0; // source-image crop window
  let actions = []; // {type:'stroke'|'erase'|'text'|'sticker', ...}
  let currentTool = 'move';
  let currentColor = '#a5502e';
  let currentSize = 6;
  let currentSticker = STICKERS[0];
  let dragging = false;
  let draggedAction = null;
  let dragStart = null;
  let cropStart = null;
  let onSaveCb = null;
  let onRetakeCb = null;

  function ensureDom() {
    overlay = document.getElementById('editorOverlay');
    canvas = document.getElementById('editorCanvas');
    ctx = canvas.getContext('2d');
  }

  function computeInitialCrop() {
    const iw = baseImg.naturalWidth, ih = baseImg.naturalHeight;
    const destAspect = width / height;
    const srcAspect = iw / ih;
    if (srcAspect > destAspect) {
      cropH = ih;
      cropW = ih * destAspect;
      cropX = (iw - cropW) / 2;
      cropY = 0;
    } else {
      cropW = iw;
      cropH = iw / destAspect;
      cropX = 0;
      cropY = (ih - cropH) / 2;
    }
  }

  function clampCrop() {
    const iw = baseImg.naturalWidth, ih = baseImg.naturalHeight;
    cropX = Math.max(0, Math.min(iw - cropW, cropX));
    cropY = Math.max(0, Math.min(ih - cropH, cropY));
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    if (baseImg) {
      ctx.drawImage(baseImg, cropX, cropY, cropW, cropH, 0, 0, width, height);
    }
    actions.forEach(a => {
      if (a.type === 'stroke' || a.type === 'erase') {
        ctx.save();
        ctx.globalCompositeOperation = a.type === 'erase' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        a.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.restore();
      } else if (a.type === 'text') {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = a.color;
        ctx.font = `600 ${a.size}px "Work Sans", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(a.text, a.x, a.y);
        ctx.restore();
      } else if (a.type === 'sticker') {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = `${a.size}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.content, a.x, a.y);
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
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  function hitTestObject(pos) {
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (a.type === 'text' || a.type === 'sticker') {
        const r = a.size;
        if (Math.abs(pos.x - a.x) < r && Math.abs(pos.y - a.y) < r) return a;
      }
    }
    return null;
  }

  function onPointerDown(e) {
    e.preventDefault();
    const pos = getPos(e);

    // Dragging an existing text/sticker always takes priority
    const hit = hitTestObject(pos);
    if (hit && (currentTool === 'move' || currentTool === 'text' || currentTool === 'sticker')) {
      dragging = true;
      draggedAction = hit;
      dragStart = pos;
      return;
    }

    if (currentTool === 'move') {
      dragging = true;
      draggedAction = null;
      dragStart = pos;
      cropStart = { x: cropX, y: cropY };
      return;
    }

    if (currentTool === 'draw' || currentTool === 'erase') {
      dragging = true;
      const stroke = { type: currentTool === 'erase' ? 'erase' : 'stroke', color: currentColor, size: currentSize, points: [pos] };
      actions.push(stroke);
      draggedAction = stroke;
      render();
      return;
    }

    if (currentTool === 'text') {
      const text = prompt('Enter text:');
      if (text) {
        actions.push({ type: 'text', x: pos.x, y: pos.y, text, color: currentColor, size: Math.max(16, currentSize * 3) });
        render();
      }
      return;
    }

    if (currentTool === 'sticker') {
      actions.push({ type: 'sticker', x: pos.x, y: pos.y, content: currentSticker, size: Math.max(28, currentSize * 4) });
      render();
      return;
    }
  }

  function onPointerMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const pos = getPos(e);

    if (draggedAction && (draggedAction.type === 'text' || draggedAction.type === 'sticker')) {
      draggedAction.x = pos.x;
      draggedAction.y = pos.y;
      render();
      return;
    }

    if (draggedAction && (draggedAction.type === 'stroke' || draggedAction.type === 'erase')) {
      draggedAction.points.push(pos);
      render();
      return;
    }

    if (currentTool === 'move' && dragStart && cropStart) {
      const dx = pos.x - dragStart.x;
      const dy = pos.y - dragStart.y;
      const scale = cropW / width;
      cropX = cropStart.x - dx * scale;
      cropY = cropStart.y - dy * scale;
      clampCrop();
      render();
    }
  }

  function onPointerUp() {
    dragging = false;
    draggedAction = null;
    dragStart = null;
    cropStart = null;
  }

  function selectTool(tool) {
    currentTool = tool;
    document.querySelectorAll('#editorToolbar .tool-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.tool === tool);
    });
    document.getElementById('stickerRow').style.display = tool === 'sticker' ? 'flex' : 'none';
  }

  function buildStickerRow() {
    const row = document.getElementById('stickerRow');
    row.innerHTML = '';
    STICKERS.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.className = 'sticker-btn' + (i === 0 ? ' selected' : '');
      btn.textContent = s;
      btn.onclick = () => {
        currentSticker = s;
        row.querySelectorAll('.sticker-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      };
      row.appendChild(btn);
    });
  }

  function wireControlsOnce() {
    if (wireControlsOnce._done) return;
    wireControlsOnce._done = true;

    document.getElementById('editorToolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('.tool-btn');
      if (btn) selectTool(btn.dataset.tool);
    });

    document.getElementById('editorColor').addEventListener('input', (e) => {
      currentColor = e.target.value;
    });
    document.getElementById('editorSize').addEventListener('input', (e) => {
      currentSize = Number(e.target.value);
    });

    document.getElementById('editorCancelBtn').addEventListener('click', close);

    document.getElementById('editorSaveBtn').addEventListener('click', () => {
      render();
      const dataUrl = canvas.toDataURL('image/png');
      if (onSaveCb) onSaveCb(dataUrl);
      close();
    });

    document.getElementById('editorRetakeBtn').addEventListener('click', async () => {
      if (!onRetakeCb) return;
      const btn = document.getElementById('editorRetakeBtn');
      btn.disabled = true;
      btn.textContent = 'Retaking…';
      try {
        const newSrc = await onRetakeCb();
        if (newSrc) {
          const img = new Image();
          img.onload = () => {
            baseImg = img;
            computeInitialCrop();
            actions = [];
            render();
          };
          img.src = newSrc;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Retake shot';
      }
    });

    ['pointerdown'].forEach(evt => canvas.addEventListener(evt, onPointerDown));
    ['pointermove'].forEach(evt => window.addEventListener(evt, onPointerMove));
    ['pointerup', 'pointercancel'].forEach(evt => window.addEventListener(evt, onPointerUp));
  }

  function open({ imageSrc, width: w, height: h, onSave, onRetake }) {
    ensureDom();
    wireControlsOnce();
    buildStickerRow();

    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
    actions = [];
    onSaveCb = onSave;
    onRetakeCb = onRetake || null;

    document.getElementById('editorRetakeBtn').style.display = onRetakeCb ? 'inline-flex' : 'none';

    selectTool('move');
    currentColor = document.getElementById('editorColor').value;
    currentSize = Number(document.getElementById('editorSize').value);

    const img = new Image();
    img.onload = () => {
      baseImg = img;
      computeInitialCrop();
      render();
    };
    img.src = imageSrc;

    overlay.classList.add('open');
  }

  function close() {
    overlay.classList.remove('open');
    baseImg = null;
    actions = [];
  }

  return { open, close };
})();

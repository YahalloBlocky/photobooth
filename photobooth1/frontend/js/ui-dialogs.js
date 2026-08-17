// =========================================================
// Custom alert/confirm/prompt dialogs, styled to match the site
// instead of using the browser's native (unstyleable) versions.
// Injects its own modal markup into the page on first use.
// =========================================================

const UIDialog = (() => {
  let overlay = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <button class="modal-close" id="uiDialogClose" aria-label="Close">&times;</button>
        <h3 id="uiDialogTitle">Notice</h3>
        <p id="uiDialogMessage" style="margin-top:-6px;"></p>
        <input type="text" id="uiDialogInput" style="display:none;">
        <div class="button-row" style="justify-content:flex-end; margin-top:10px;">
          <button class="btn btn-ghost" id="uiDialogCancel">Cancel</button>
          <button class="btn btn-primary" id="uiDialogOk">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function show({ title, message, showInput, defaultValue, showCancel }) {
    ensureDom();
    return new Promise((resolve) => {
      document.getElementById('uiDialogTitle').textContent = title || 'Notice';
      document.getElementById('uiDialogMessage').textContent = message || '';
      const input = document.getElementById('uiDialogInput');
      input.style.display = showInput ? 'block' : 'none';
      input.value = defaultValue || '';
      document.getElementById('uiDialogCancel').style.display = showCancel ? 'inline-flex' : 'none';

      overlay.classList.add('open');
      document.body.classList.add('scroll-locked');
      if (showInput) setTimeout(() => input.focus(), 50);

      const cleanup = (result) => {
        overlay.classList.remove('open');
        document.body.classList.remove('scroll-locked');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKeydown);
        resolve(result);
      };

      const okBtn = document.getElementById('uiDialogOk');
      const cancelBtn = document.getElementById('uiDialogCancel');
      const closeBtn = document.getElementById('uiDialogClose');

      const onOk = () => cleanup(showInput ? input.value : true);
      const onCancel = () => cleanup(showInput ? null : false);
      const onKeydown = (e) => { if (e.key === 'Enter') onOk(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKeydown);
    });
  }

  return {
    alert(message, title) {
      return show({ title: title || 'Notice', message, showInput: false, showCancel: false });
    },
    confirm(message, title) {
      return show({ title: title || 'Are you sure?', message, showInput: false, showCancel: true });
    },
    prompt(message, defaultValue, title) {
      return show({ title: title || 'Enter a value', message, showInput: true, defaultValue, showCancel: true });
    }
  };
})();

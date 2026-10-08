// Tiny shared UI helpers used from more than one screen: a transient toast
// and a promise-based confirm dialog. Both live at the root of #app (see
// index.html) so they sit above whichever screen is showing — and, unlike
// window.confirm(), they work inside a kiosk/home-screen web app.

let toastTimer = null;

export function showToast(text, ms = 3200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  // Restart the CSS enter animation if a toast is already showing.
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    el.hidden = true;
  }, ms);
}

// Resolves true if the person confirms, false if they cancel (or tap the
// backdrop). Only one dialog can be open at a time.
export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  const root = document.getElementById("dialog");
  const titleEl = document.getElementById("dialog-title");
  const msgEl = document.getElementById("dialog-message");
  const okBtn = document.getElementById("dialog-confirm");
  const cancelBtn = document.getElementById("dialog-cancel");
  if (!root) return Promise.resolve(false);

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  okBtn.classList.toggle("btn-danger", danger);
  okBtn.classList.toggle("btn-primary", !danger);
  root.hidden = false;

  return new Promise((resolve) => {
    const finish = (result) => {
      root.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      root.removeEventListener("pointerdown", onBackdrop);
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => {
      if (e.target === root) finish(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    root.addEventListener("pointerdown", onBackdrop);
  });
}

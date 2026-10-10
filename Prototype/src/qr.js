// Draws a QR code onto a <canvas>. The encoder is a small third-party
// library, loaded lazily the first time it's needed (rather than as a static
// import) so that a CDN hiccup can only ever cost us the QR code — never stop
// the app itself from starting.
const QR_LIB_URL = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm";

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = import(QR_LIB_URL).then((m) => m.default || m);
    libPromise.catch(() => {
      libPromise = null; // allow a retry on the next round
    });
  }
  return libPromise;
}

// `size` is the on-screen size in CSS px; the backing store is scaled by the
// device pixel ratio and snapped to whole pixels per module so the squares
// stay perfectly sharp (blurry modules are what make QR codes hard to scan).
export async function drawQr(canvas, text, size = 200) {
  const qrcode = await loadLib();
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 2; // modules of white border (the spec asks for 4, 2 scans fine on a white card)
  const dpr = window.devicePixelRatio || 1;
  const cell = Math.max(2, Math.floor((size * dpr) / (count + quiet * 2)));
  const px = cell * (count + quiet * 2);

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#232733";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }
}

// Shared raster flood-fill, used by both the duet canvas (canvas.js) and
// the message-board note composer (board.js) for their "fill" tool.
//
// Strokes elsewhere in this app are vector data (arrays of normalized
// points) replayed by drawing lines — that doesn't make sense for a bucket
// fill, which has to operate on actual pixels. A fill is instead recorded
// as a one-point "stroke" ({ tool: "fill", color, points: [pt] }) and
// replayed by re-running this same algorithm against whatever the canvas
// looks like at that point in the replay — deterministic as long as
// everything before it replays in the same order, which strokes already do.

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Fills the region of matching colour touching (startX, startY) — both in
// actual device pixels of ctx's canvas, not CSS/logical pixels — with
// fillColor (a "#rrggbb" string). tolerance allows filling lightly
// anti-aliased edges along with the flat region, so it doesn't leave a
// thin ring of the old colour around the fill.
export function floodFillPixels(ctx, width, height, startX, startY, fillColor, tolerance = 40) {
  startX = Math.round(startX);
  startY = Math.round(startY);
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return;

  // A fill always runs right after other strokes were just drawn to this
  // same canvas in the same tick (see canvas.js/board.js). getImageData is
  // spec'd to force a synchronous readback, but some canvas backends have
  // been observed returning a not-yet-fully-flushed framebuffer when it's
  // called immediately after other draw calls in the same task — the
  // symptom being a "speckled", mostly-unfilled result even though the
  // target region is genuinely uniform. A cheap throwaway 1x1 read forces
  // that flush before the real one.
  ctx.getImageData(0, 0, 1, 1);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const [fr, fg, fb] = hexToRgb(fillColor);
  const fa = 255;

  const startIdx = (startY * width + startX) * 4;
  const sr = data[startIdx];
  const sg = data[startIdx + 1];
  const sb = data[startIdx + 2];
  const sa = data[startIdx + 3];
  if (sr === fr && sg === fg && sb === fb && sa === fa) return; // already this colour

  const tol2 = tolerance * tolerance;
  const matches = (idx) => {
    const dr = data[idx] - sr;
    const dg = data[idx + 1] - sg;
    const db = data[idx + 2] - sb;
    const da = data[idx + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tol2;
  };

  const visited = new Uint8Array(width * height);
  const stack = [startX, startY];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const vIdx = y * width + x;
    if (visited[vIdx]) continue;
    const idx = vIdx * 4;
    if (!matches(idx)) continue;
    visited[vIdx] = 1;
    data[idx] = fr;
    data[idx + 1] = fg;
    data[idx + 2] = fb;
    data[idx + 3] = fa;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  ctx.putImageData(imageData, 0, 0);
}

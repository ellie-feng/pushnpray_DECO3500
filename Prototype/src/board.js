// Shared infinite whiteboard: one continuous raster canvas per station that
// anyone can draw on directly, strokes free to overlap — no cells, no
// claiming. Panning/zooming the view (see the pointer handlers wired up in
// game.js) only ever moves a CSS transform on .board-canvas-wrap; drawing
// paints straight into the canvas's own pixel buffer, in an untransformed
// "world" coordinate space that a screen point is converted into on the way
// in (see _screenToWorld). That split — world space for storage/painting,
// screen space only ever converted at the pointer-event boundary — is what
// lets the canvas keep growing as people draw near its edge without
// touching the pan/zoom math at all.
import { floodFillPixels } from "./floodfill.js";

const SIZES = { s: 4, m: 9, l: 18 };
// Margin (world px) always kept clear beyond the farthest stroke point, in
// every direction — this is what makes the canvas keep growing outward
// instead of clipping the moment someone draws near its current edge.
const WORLD_PAD = 300;
// Half-extents the canvas starts at (and never shrinks below) even with no
// strokes yet, so there's room to draw and look around before any resize
// logic kicks in.
const DEFAULT_HALF_W = 700;
const DEFAULT_HALF_H = 450;

function styleFor(tool, sizeKey) {
  const base = SIZES[sizeKey] || SIZES.m;
  if (tool === "highlighter") return { width: base * 2.6, alpha: 0.35, composite: "multiply", constant: true };
  if (tool === "eraser") return { width: base * 2.2, alpha: 1, composite: "destination-out", constant: true };
  return { width: base, alpha: 1, composite: "source-over", constant: false };
}

// Paints one stroke's points — already in canvas-local CSS px, see
// BoardCanvas._toLocal — onto ctx, at device-pixel resolution via dpr.
function paintStroke(ctx, points, tool, color, sizeKey, dpr) {
  if (!points || points.length === 0) return;
  if (tool === "fill") {
    floodFillPixels(ctx, ctx.canvas.width, ctx.canvas.height, points[0].x * dpr, points[0].y * dpr, color);
    return;
  }
  const style = styleFor(tool, sizeKey);
  ctx.save();
  ctx.globalCompositeOperation = style.composite;
  ctx.globalAlpha = style.alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    const p = points[0];
    const w = style.constant ? style.width : style.width * (0.4 + 0.9 * (p.p ?? 0.5));
    ctx.beginPath();
    ctx.arc(p.x * dpr, p.y * dpr, (w * dpr) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      const w = style.constant ? style.width : style.width * (0.4 + 0.9 * (p1.p ?? 0.5));
      ctx.lineWidth = w * dpr;
      ctx.beginPath();
      ctx.moveTo(p0.x * dpr, p0.y * dpr);
      ctx.lineTo(p1.x * dpr, p1.y * dpr);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// The occupied extent padded by WORLD_PAD, unioned with the default
// half-extents so the canvas never starts (or shrinks) smaller than that.
function computeBounds(strokes) {
  let minX = -DEFAULT_HALF_W;
  let maxX = DEFAULT_HALF_W;
  let minY = -DEFAULT_HALF_H;
  let maxY = DEFAULT_HALF_H;
  for (const stroke of strokes.values()) {
    for (const p of stroke.points || []) {
      if (p.x - WORLD_PAD < minX) minX = p.x - WORLD_PAD;
      if (p.x + WORLD_PAD > maxX) maxX = p.x + WORLD_PAD;
      if (p.y - WORLD_PAD < minY) minY = p.y - WORLD_PAD;
      if (p.y + WORLD_PAD > maxY) maxY = p.y + WORLD_PAD;
    }
  }
  return { minX, maxX, minY, maxY };
}

export class BoardCanvas {
  // base/live: the two stacked <canvas> elements. wrap: their shared parent,
  // the element the pan/zoom CSS transform is applied to. viewport: the
  // outer, non-transformed element pointer coordinates are measured against.
  // getTransform(): () => {panX, panY, zoom}, read fresh on every pointer
  // event since it changes during a drag. onLocalStrokeEnd(stroke): called
  // with a finished stroke (world-space points) for the caller to persist.
  constructor({ base, live, wrap, viewport, getTransform, onLocalStrokeEnd }) {
    this.base = base;
    this.live = live;
    this.wrap = wrap;
    this.viewport = viewport;
    this.getTransform = getTransform;
    this.onLocalStrokeEnd = onLocalStrokeEnd;
    this.bctx = base.getContext("2d");
    this.lctx = live.getContext("2d");

    this.tool = "pen";
    this.color = "#232733";
    this.size = "m";

    this.strokes = new Map(); // id -> stroke, world coords, insertion-ordered
    this.bounds = null;
    this.myPoints = null; // world coords, current in-progress stroke
    this.myStyle = null;
    this.activePointerId = null;

    this._applyBounds(computeBounds(this.strokes));

    // Listeners live on the viewport, not the canvases themselves, because
    // the viewport is also where game.js listens for the pan/zoom gesture —
    // see _onDown for the pointerType split that keeps the two from
    // fighting over the same pointer.
    this.viewport.addEventListener("pointerdown", (e) => this._onDown(e));
    this.viewport.addEventListener("pointermove", (e) => this._onMove(e));
    this.viewport.addEventListener("pointerup", (e) => this._onUp(e));
    this.viewport.addEventListener("pointercancel", (e) => this._onUp(e));
  }

  setTool(t) {
    this.tool = t;
  }
  setColor(c) {
    this.color = c;
  }
  setSize(s) {
    this.size = s;
  }

  // Called with the full, authoritative strokes object from Firebase every
  // time anything on this station's board changes — simplest correct thing
  // (rebuild fully rather than diff incrementally) given how infrequently a
  // public-kiosk board actually gets drawn on. onBoundsShift(dx, dy) fires
  // when the canvas's local origin moves, so the caller can shift its pan
  // offset by the same amount and keep existing content pinned on screen —
  // otherwise a stroke posted near the current edge would silently teleport
  // the whole board on the next render.
  setStrokes(strokesObj, onBoundsShift) {
    this.strokes = new Map(Object.entries(strokesObj || {}));
    this._applyBounds(computeBounds(this.strokes), onBoundsShift);
    this._redrawBase();
  }

  // Called right after a local stroke is committed (see game.js), with the
  // same id it was/will be pushed to Firebase under, and does the actual
  // painting — see _onUp/_onDown below, which report the finished stroke
  // without painting it themselves. Firebase's local cache reflects a write
  // immediately, but reverts it — re-firing this station's onValue listener
  // with the *old* data — if the server then rejects it (e.g. a permissions
  // issue); registering the stroke here first, not just painting it once,
  // is what keeps it from being wiped out by that revert. Once the real
  // snapshot does arrive with this id included, setStrokes() just replaces
  // this entry with an equivalent one — no visible change, no dedup needed.
  registerLocalStroke(id, stroke, onBoundsShift) {
    this.strokes.set(id, stroke);
    this._applyBounds(computeBounds(this.strokes), onBoundsShift);
    this._redrawBase();
  }

  // World-space centre of the actual drawn content, or the origin if the
  // board is still empty — used to centre the view on first landing.
  getContentCenter() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const stroke of this.strokes.values()) {
      for (const p of stroke.points || []) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (minX > maxX) return { x: 0, y: 0 };
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  _applyBounds(next, onBoundsShift) {
    const prev = this.bounds;
    this.bounds = next;
    const w = next.maxX - next.minX;
    const h = next.maxY - next.minY;
    const dpr = window.devicePixelRatio || 1;
    this.wrap.style.width = `${w}px`;
    this.wrap.style.height = `${h}px`;
    for (const cv of [this.base, this.live]) {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    if (prev && onBoundsShift && (next.minX !== prev.minX || next.minY !== prev.minY)) {
      onBoundsShift(next.minX - prev.minX, next.minY - prev.minY);
    }
  }

  _toLocal(worldPoint) {
    return { x: worldPoint.x - this.bounds.minX, y: worldPoint.y - this.bounds.minY, p: worldPoint.p };
  }

  _redrawBase() {
    const dpr = window.devicePixelRatio || 1;
    this.bctx.clearRect(0, 0, this.base.width, this.base.height);
    for (const stroke of this.strokes.values()) {
      const localPts = (stroke.points || []).map((p) => this._toLocal(p));
      paintStroke(this.bctx, localPts, stroke.tool, stroke.color, stroke.size, dpr);
    }
  }

  _redrawLive() {
    const dpr = window.devicePixelRatio || 1;
    this.lctx.clearRect(0, 0, this.live.width, this.live.height);
    if (this.myPoints && this.myPoints.length > 0) {
      const localPts = this.myPoints.map((p) => this._toLocal(p));
      paintStroke(this.lctx, localPts, this.myStyle.tool, this.myStyle.color, this.myStyle.size, dpr);
    }
  }

  // Screen (clientX/clientY) -> world coordinates: undo the viewport's
  // current pan/zoom, then this canvas's own local origin.
  _screenToWorld(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    const { panX, panY, zoom } = this.getTransform();
    return {
      x: (clientX - rect.left - panX) / zoom + this.bounds.minX,
      y: (clientY - rect.top - panY) / zoom + this.bounds.minY,
    };
  }

  _onDown(e) {
    // Pencil (or mouse, for desktop testing) draws; fingers pan and
    // pinch-zoom the view instead — game.js's own viewport handlers do the
    // mirror-image check, so a given pointer is only ever handled by one
    // side of this split.
    if (e.pointerType === "touch") return;
    if (this.activePointerId !== null) return;
    const pt = this._screenToWorld(e.clientX, e.clientY);
    pt.p = e.pressure > 0 ? e.pressure : 0.5;

    if (this.tool === "fill") {
      // Atomic — a tap, not a drag — so it skips the live-preview/pointer
      // tracking entirely and commits straight away. Painting happens once
      // the caller registers it (see registerLocalStroke) rather than here,
      // so there's exactly one place that replays strokes onto the canvas.
      this.onLocalStrokeEnd({ tool: "fill", color: this.color, size: this.size, points: [pt] });
      e.preventDefault();
      return;
    }

    this.activePointerId = e.pointerId;
    this.myPoints = [pt];
    this.myStyle = { tool: this.tool, color: this.color, size: this.size };
    try {
      // Best-effort: keeps the stroke tracking this pointer even if it drags
      // outside the canvas mid-move. Not fatal if the browser refuses it —
      // stroke state above is already set up regardless.
      this.viewport.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this._redrawLive();
    e.preventDefault();
  }

  _onMove(e) {
    if (e.pointerId !== this.activePointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const pt = this._screenToWorld(ev.clientX, ev.clientY);
      pt.p = ev.pressure > 0 ? ev.pressure : 0.5;
      this.myPoints.push(pt);
    }
    this._redrawLive();
    e.preventDefault();
  }

  _onUp(e) {
    if (e.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    const points = this.myPoints;
    const style = this.myStyle;
    this.myPoints = null;
    this.myStyle = null;
    this._redrawLive();
    if (points && points.length > 0) {
      // Painting happens once the caller registers it (see
      // registerLocalStroke), not here — one place replays strokes onto
      // the canvas, whether they just got drawn, redone, or synced in.
      this.onLocalStrokeEnd({ tool: style.tool, color: style.color, size: style.size, points });
    }
  }
}

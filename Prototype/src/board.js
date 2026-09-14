// Local-only sketch composer for a message-board note, plus a renderer for
// showing saved notes as small static thumbnails in the trail feed.
//
// Deliberately separate from canvas.js's DrawingCanvas: that engine is built
// for two devices live-syncing strokes to each other mid-draw, with turn
// gating and a remote-preview layer. A board note is composed by one person,
// alone, then posted as a single finished unit — a much simpler shape, so it
// gets its own small engine rather than overloading the duet one. The two
// duplicate a little stroke-painting math, which is an acceptable tradeoff
// for not risking the already-verified duet drawing code.
const SIZES = { s: 4, m: 9, l: 18 };

function styleFor(tool, sizeKey) {
  const base = SIZES[sizeKey] || SIZES.m;
  if (tool === "highlighter") return { width: base * 2.6, alpha: 0.35, composite: "multiply", constant: true };
  if (tool === "eraser") return { width: base * 2.2, alpha: 1, composite: "destination-out", constant: true };
  return { width: base, alpha: 1, composite: "source-over", constant: false };
}

// Paints one stroke's normalized (0..1) points onto ctx, denormalized
// against a w x h logical canvas size.
export function paintStroke(ctx, points, tool, color, sizeKey, w, h) {
  if (!points || points.length === 0) return;
  const style = styleFor(tool, sizeKey);
  const denorm = (pt) => ({ x: pt.x * w, y: pt.y * h, p: pt.p });
  ctx.save();
  ctx.globalCompositeOperation = style.composite;
  ctx.globalAlpha = style.alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    const p = denorm(points[0]);
    const w2 = style.constant ? style.width : style.width * (0.4 + 0.9 * (p.p ?? 0.5));
    ctx.beginPath();
    ctx.arc(p.x, p.y, w2 / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    for (let i = 1; i < points.length; i++) {
      const p0 = denorm(points[i - 1]);
      const p1 = denorm(points[i]);
      const w2 = style.constant ? style.width : style.width * (0.4 + 0.9 * (p1.p ?? 0.5));
      ctx.lineWidth = w2;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export class NoteComposer {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.tool = "pen";
    this.color = "#232733";
    this.size = "m";
    this.strokes = [];
    this.current = null;
    this.activePointerId = null;
    this._penSeen = false;

    this._resize = this._resize.bind(this);
    window.addEventListener("resize", this._resize);
    window.addEventListener("orientationchange", () => setTimeout(this._resize, 200));
    this._resize();

    this.canvas.style.touchAction = "none";
    this.canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this._onMove(e));
    this.canvas.addEventListener("pointerup", (e) => this._onUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this._onUp(e));
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

  // Call when the composer becomes visible again (e.g. returning to the
  // board screen) — same reasoning as DrawingCanvas.resize().
  resize() {
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this._redraw();
  }

  _redraw() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.strokes) paintStroke(this.ctx, s.points, s.tool, s.color, s.size, this.w, this.h);
    if (this.current) {
      paintStroke(this.ctx, this.current.points, this.current.tool, this.current.color, this.current.size, this.w, this.h);
    }
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this._redraw();
  }

  // Plain-object copy of the composed strokes, ready to post to Firebase.
  exportStrokes() {
    return this.strokes.map((s) => ({ tool: s.tool, color: s.color, size: s.size, points: s.points }));
  }

  _norm(x, y) {
    return { x: x / this.w, y: y / this.h };
  }

  _onDown(e) {
    if (this.activePointerId !== null) return;
    if (e.pointerType === "touch" && this._penSeen) return; // simple palm rejection
    if (e.pointerType === "pen") this._penSeen = true;
    this.activePointerId = e.pointerId;
    this.activePointerType = e.pointerType;
    const rect = this.canvas.getBoundingClientRect();
    const pt = this._norm(e.clientX - rect.left, e.clientY - rect.top);
    pt.p = e.pressure > 0 ? e.pressure : 0.5;
    this.current = { tool: this.tool, color: this.color, size: this.size, points: [pt] };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort only, see canvas.js for why this can throw */
    }
    this._redraw();
    e.preventDefault();
  }

  _onMove(e) {
    if (e.pointerId !== this.activePointerId || !this.current) return;
    const rect = this.canvas.getBoundingClientRect();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const pt = this._norm(ev.clientX - rect.left, ev.clientY - rect.top);
      pt.p = ev.pressure > 0 ? ev.pressure : 0.5;
      this.current.points.push(pt);
    }
    this._redraw();
    e.preventDefault();
  }

  _onUp(e) {
    if (e.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    if (this.activePointerType === "pen") this._penSeen = false;
    if (this.current && this.current.points.length > 0) {
      this.strokes.push(this.current);
    }
    this.current = null;
    this._redraw();
  }
}

// Renders a saved note's strokes into a small static <canvas> — used for
// each item in the trail feed. Not interactive.
export function renderNoteThumbnail(canvasEl, strokes) {
  const ctx = canvasEl.getContext("2d");
  const rect = canvasEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width || 160;
  const h = rect.height || 100;
  canvasEl.width = Math.max(1, Math.round(w * dpr));
  canvasEl.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const s of strokes || []) paintStroke(ctx, s.points, s.tool, s.color, s.size, w, h);
}

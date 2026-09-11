// Two-layer drawing engine: a base canvas holds committed strokes, a live
// canvas on top holds in-progress strokes (mine + the other player's) so
// undo/resize only ever has to replay the committed layer.
const SIZES = { s: 4, m: 9, l: 18 };

export class DrawingCanvas {
  constructor(baseCanvas, liveCanvas, handlers) {
    this.base = baseCanvas;
    this.live = liveCanvas;
    this.bctx = baseCanvas.getContext("2d");
    this.lctx = liveCanvas.getContext("2d");
    this.handlers = handlers; // { canDraw(), onLocalStrokePoints(points, style), onLocalStrokeEnd(points, style) }

    this.tool = "pen";
    this.color = "#232733";
    this.size = "m";
    this.myRole = null;

    this.strokes = new Map(); // id -> stroke, insertion-ordered
    this.ownIds = new Set();
    this.remoteLive = { A: null, B: null };

    this.myPoints = null;
    this.myStyle = null;
    this.activePointerId = null;
    this.activePointerType = null;
    this._penSeen = false;
    this.lastPublish = 0;

    this._resize = this._resize.bind(this);
    window.addEventListener("resize", this._resize);
    window.addEventListener("orientationchange", () => setTimeout(this._resize, 200));
    this._resize();

    this.live.style.touchAction = "none";
    this.live.addEventListener("pointerdown", (e) => this._onDown(e));
    this.live.addEventListener("pointermove", (e) => this._onMove(e));
    this.live.addEventListener("pointerup", (e) => this._onUp(e));
    this.live.addEventListener("pointercancel", (e) => this._onUp(e));
  }

  setMyRole(role) {
    this.myRole = role;
  }

  // Call whenever the canvas becomes visible (e.g. switching to the play
  // screen) — while `hidden`, its box has zero size, so measuring on
  // construction alone isn't enough.
  resize() {
    this._resize();
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

  _resize() {
    const rect = this.base.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const [cv, ctx] of [
      [this.base, this.bctx],
      [this.live, this.lctx],
    ]) {
      cv.width = Math.max(1, Math.round(rect.width * dpr));
      cv.height = Math.max(1, Math.round(rect.height * dpr));
      cv.style.width = rect.width + "px";
      cv.style.height = rect.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.w = rect.width;
    this.h = rect.height;
    this._redrawBase();
    this._redrawLiveLayer();
  }

  _denorm(pt) {
    return { x: pt.x * this.w, y: pt.y * this.h, p: pt.p };
  }
  _norm(x, y) {
    return { x: x / this.w, y: y / this.h };
  }

  _styleFor(tool, sizeKey) {
    const base = SIZES[sizeKey] || SIZES.m;
    if (tool === "highlighter") {
      return { width: base * 2.6, alpha: 0.35, composite: "multiply", constant: true };
    }
    if (tool === "eraser") {
      return { width: base * 2.2, alpha: 1, composite: "destination-out", constant: true };
    }
    return { width: base, alpha: 1, composite: "source-over", constant: false };
  }

  _paintPath(ctx, points, tool, color, sizeKey) {
    if (!points || points.length === 0) return;
    const style = this._styleFor(tool, sizeKey);
    ctx.save();
    ctx.globalCompositeOperation = style.composite;
    ctx.globalAlpha = style.alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (points.length === 1) {
      const p = this._denorm(points[0]);
      const w = style.constant ? style.width : style.width * (0.4 + 0.9 * (p.p ?? 0.5));
      ctx.beginPath();
      ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < points.length; i++) {
        const p0 = this._denorm(points[i - 1]);
        const p1 = this._denorm(points[i]);
        const w = style.constant ? style.width : style.width * (0.4 + 0.9 * (p1.p ?? 0.5));
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _redrawBase() {
    this.bctx.clearRect(0, 0, this.w, this.h);
    for (const stroke of this.strokes.values()) {
      this._paintPath(this.bctx, stroke.points, stroke.tool, stroke.color, stroke.size);
    }
  }

  _redrawLiveLayer() {
    this.lctx.clearRect(0, 0, this.w, this.h);
    const other = this.myRole === "A" ? "B" : "A";
    const theirs = this.remoteLive[other];
    if (theirs && theirs.points && theirs.points.length > 0) {
      this._paintPath(this.lctx, theirs.points, theirs.tool, theirs.color, theirs.size);
    }
    if (this.myPoints && this.myPoints.length > 0) {
      this._paintPath(this.lctx, this.myPoints, this.myStyle.tool, this.myStyle.color, this.myStyle.size);
    }
  }

  // Remote stroke that just completed elsewhere.
  addStrokeIfNew(id, stroke) {
    if (this.ownIds.has(id)) return; // already rendered when I committed it
    this.strokes.set(id, stroke);
    this._paintPath(this.bctx, stroke.points, stroke.tool, stroke.color, stroke.size);
  }

  // My own stroke, already painted immediately on pointer-up for
  // responsiveness — just record it so undo/resize/redraw know about it and
  // so the echoed child_added from Firebase is ignored.
  registerOwnStroke(id, stroke) {
    this.ownIds.add(id);
    this.strokes.set(id, stroke);
  }

  removeStroke(id) {
    if (!this.strokes.has(id)) return;
    this.strokes.delete(id);
    this.ownIds.delete(id);
    this._redrawBase();
  }

  clearAll() {
    this.strokes.clear();
    this.ownIds.clear();
    this.remoteLive = { A: null, B: null };
    this._redrawBase();
    this._redrawLiveLayer();
  }

  setRemoteLive(role, data) {
    this.remoteLive[role] = data;
    this._redrawLiveLayer();
  }

  _onDown(e) {
    if (!this.handlers.canDraw()) return;
    if (this.activePointerId !== null) return;
    if (e.pointerType === "touch" && this._penSeen) return; // simple palm rejection
    if (e.pointerType === "pen") this._penSeen = true;
    this.activePointerId = e.pointerId;
    this.activePointerType = e.pointerType;
    const rect = this.live.getBoundingClientRect();
    const pt = this._norm(e.clientX - rect.left, e.clientY - rect.top);
    pt.p = e.pressure > 0 ? e.pressure : 0.5;
    this.myPoints = [pt];
    this.myStyle = { tool: this.tool, color: this.color, size: this.size };
    try {
      // Best-effort: keeps the stroke tracking this pointer even if it drags
      // outside the canvas mid-move. Not fatal if the browser refuses it —
      // stroke state above is already set up regardless.
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this._redrawLiveLayer();
    e.preventDefault();
  }

  _onMove(e) {
    if (e.pointerId !== this.activePointerId) return;
    const rect = this.live.getBoundingClientRect();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const pt = this._norm(ev.clientX - rect.left, ev.clientY - rect.top);
      pt.p = ev.pressure > 0 ? ev.pressure : 0.5;
      this.myPoints.push(pt);
    }
    this._redrawLiveLayer();
    const now = performance.now();
    if (now - this.lastPublish > 55) {
      this.lastPublish = now;
      this.handlers.onLocalStrokePoints(this.myPoints, this.myStyle);
    }
    e.preventDefault();
  }

  _onUp(e) {
    if (e.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    if (this.activePointerType === "pen") this._penSeen = false;
    const points = this.myPoints;
    const style = this.myStyle;
    this.myPoints = null;
    this.myStyle = null;
    this._redrawLiveLayer();
    if (points && points.length > 0) {
      this._paintPath(this.bctx, points, style.tool, style.color, style.size);
    }
    this.handlers.onLocalStrokeEnd(points || [], style || {});
  }
}

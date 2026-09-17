// Top-level state machine: message-board mode (default) vs. the duet
// drawing minigame, which triggers automatically when both stations are
// genuinely active at the same time. Also owns the synced duet timing/turn
// logic and all the screen/HUD updates that follow from it.
import * as rt from "./realtime.js";
import { DrawingCanvas } from "./canvas.js";
import { BoardCanvas } from "./board.js";

const TURN_MS = 30000;
// How fresh a heartbeat must be to count as "someone is using this station
// right now" for the purposes of triggering a duet.
const ACTIVE_WINDOW_MS = 9000;
// How long the finish/reveal screen stays up before auto-returning to the
// board (a "Done" button can also skip this early).
const FINISH_VIEW_MS = 10000;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

let els = null;
let station = null; // { id, label, icon, prompts, duetRole }
let role = null; // "A" | "B" — fixed by station, never claimed
let canvasEngine = null;
let boardCanvasEngine = null; // BoardCanvas — this station's shared whiteboard
let myBoardStrokes = []; // [{id, stroke}] this device's own board strokes, in order — for undo
let boardRedoStack = []; // strokes this device has undone, poppable to redo — cleared by any new stroke

// ---- board pan/zoom (fully custom — not native scroll — see the pointer
// handlers set up in init() for why) ----
let panX = 0;
let panY = 0;
let zoom = 1;
const trackedPointers = new Map(); // pointerId -> {x, y}, in client coords — touch only; pen/mouse draws instead, see onViewportPointerDown
let pinchStartDist = 0;
let pinchStartZoom = 1;
let presence = {};
let session = { state: "board", round: 0 };
let myStrokes = []; // [{id, stroke}] this device's own strokes still on the duet canvas, in order
let myRedoStack = []; // strokes this device has undone, poppable to redo — cleared by any new stroke

let currentScreenName = null;
let currentCanDraw = false;
let lastServerState = null; // for detecting session.state edges (board -> lobby, etc.)
let localLandingSeen = false; // per visit: has this device tapped past the landing splash yet
let localOnboardingSeen = false; // per-round: has this device clicked through onboarding yet
let alertTimer = null;
let localAlertSeen = false;
let lastTurnRole = null;
let lastTickSecond = null;
let finishShown = false;
let finishReturnAt = null;
let returnRequested = false;
let bannerTimeout = null;
let audioCtx = null;
let onDuetStartCallbacks = [];
let boardPrompt = "";
let boardScrolled = false; // per visit: has the view been scrolled to existing content yet
let trailLoaded = false; // has watchTrail delivered its first real snapshot yet

export async function init(domEls, stationConfig) {
  els = domEls;
  station = stationConfig;
  role = station.duetRole;

  canvasEngine = new DrawingCanvas(els.canvasBase, els.canvasLive, {
    canDraw: () => currentCanDraw,
    onLocalStrokePoints: (points, style) => {
      rt.publishLive(role, { tool: style.tool, color: style.color, size: style.size, points });
    },
    onLocalStrokeEnd: (points, style) => {
      rt.clearLive(role);
      if (!points || points.length === 0) return;
      const stroke = { role, tool: style.tool, color: style.color, size: style.size, points, t: Date.now() };
      const id = rt.commitStroke(stroke);
      myStrokes.push({ id, stroke });
      myRedoStack = []; // a new stroke invalidates any pending redo
      canvasEngine.registerOwnStroke(id, stroke);
    },
  });
  canvasEngine.setMyRole(role);

  rt.initPresence(role);
  session = (await rt.ensureSession()) || session;

  rt.watchPresence((p) => {
    presence = p;
  });
  rt.watchSession((s) => {
    session = s || { state: "board", round: 0 };
  });
  rt.watchStrokes(
    (id, stroke) => canvasEngine.addStrokeIfNew(id, stroke),
    (id) => {
      canvasEngine.removeStroke(id);
      myStrokes = myStrokes.filter((e) => e.id !== id);
    }
  );
  rt.watchLive("A", (data) => {
    if (role !== "A") canvasEngine.setRemoteLive("A", data);
  });
  rt.watchLive("B", (data) => {
    if (role !== "B") canvasEngine.setRemoteLive("B", data);
  });
  boardCanvasEngine = new BoardCanvas({
    base: els.boardCanvasBase,
    live: els.boardCanvasLive,
    wrap: els.boardCanvasWrap,
    viewport: els.boardViewport,
    getTransform: () => ({ panX, panY, zoom }),
    onLocalStrokeEnd: (stroke) => {
      const id = rt.postBoardStroke(station.id, stroke);
      boardCanvasEngine.registerLocalStroke(id, stroke, shiftBoardPan);
      myBoardStrokes.push({ id, stroke });
      boardRedoStack = []; // a new stroke invalidates any pending redo
    },
  });

  rt.watchTrail(station.id, (strokes) => {
    boardCanvasEngine.setStrokes(strokes, shiftBoardPan);
    trailLoaded = true;
    maybeCenterBoardView();
  });

  // Pan/zoom is fully custom rather than native scroll: pinch-to-zoom has
  // no native equivalent for a single element, and mixing native scroll
  // (for pan) with a CSS transform (for zoom) means fighting over what
  // "the scroll position" even means once zoomed. touch-action:none on the
  // viewport (see styles.css) hands ALL gesture handling to these. Only
  // touch pointers reach these handlers — pen/mouse are drawing input,
  // handled entirely inside BoardCanvas (also listening on this same
  // viewport element, see its constructor).
  els.boardViewport.addEventListener("pointerdown", onViewportPointerDown);
  els.boardViewport.addEventListener("pointermove", onViewportPointerMove);
  els.boardViewport.addEventListener("pointerup", onViewportPointerUp);
  els.boardViewport.addEventListener("pointercancel", onViewportPointerUp);

  setInterval(tick, 100);
  return true;
}

export function myRole() {
  return role;
}
export function stationInfo() {
  return station;
}

// This round's word for the local player, or null if not yet available.
export function myPrompt() {
  const word = session.prompts && session.prompts[role];
  const emoji = session.emojis && session.emojis[role];
  return word ? { word, emoji } : null;
}

// main.js registers callbacks here (more than one — the onboarding
// carousel and the ready-button UI each need to reset independently)
// to run whenever a fresh duet round starts.
export function onDuetStart(cb) {
  onDuetStartCallbacks.push(cb);
}

// Called by main.js when the "Let's go" button on the last onboarding card
// is pressed — reveals the hold-to-ready screen for the rest of this round.
export function confirmOnboarding() {
  localOnboardingSeen = true;
}

export function setTool(t) {
  canvasEngine.setTool(t);
}
export function setColor(c) {
  canvasEngine.setColor(c);
}
export function setSize(s) {
  canvasEngine.setSize(s);
}
export function undo() {
  const entry = myStrokes.pop();
  if (!entry) return;
  myRedoStack.push(entry);
  rt.removeStroke(entry.id);
}
export function redo() {
  const entry = myRedoStack.pop();
  if (!entry) return;
  const id = rt.commitStroke(entry.stroke);
  myStrokes.push({ id, stroke: entry.stroke });
  canvasEngine.registerOwnStroke(id, entry.stroke);
  canvasEngine.paintStrokeDirect(entry.stroke);
}
export function markReady() {
  const round = typeof session.round === "number" ? session.round : 0;
  rt.markReady(role, round);
}

// Call on real interaction (touch/tap) anywhere on the board screen — this
// is the heartbeat that determines whether this station counts as "active"
// for the both-active duet trigger.
export function touchActive() {
  rt.touchActive(role);
}

// ---------- message board: shared infinite whiteboard ----------
export function setNoteTool(t) {
  boardCanvasEngine.setTool(t);
}
export function setNoteColor(c) {
  boardCanvasEngine.setColor(c);
}
export function setNoteSize(s) {
  boardCanvasEngine.setSize(s);
}
// Undo/redo only ever act on this device's own strokes, most-recent-first —
// nobody can undo someone else's drawing.
export function undoNote() {
  const entry = myBoardStrokes.pop();
  if (!entry) return;
  boardRedoStack.push(entry);
  rt.removeBoardStroke(station.id, entry.id);
}
export function redoNote() {
  const entry = boardRedoStack.pop();
  if (!entry) return;
  const id = rt.postBoardStroke(station.id, entry.stroke);
  boardCanvasEngine.registerLocalStroke(id, entry.stroke, shiftBoardPan);
  myBoardStrokes.push({ id, stroke: entry.stroke });
}

// Keeps existing content pinned on screen when the board canvas's local
// origin moves — see BoardCanvas.setStrokes/registerLocalStroke in board.js.
function shiftBoardPan(dx, dy) {
  panX += dx * zoom;
  panY += dy * zoom;
  applyTransform();
}

// Called when the landing splash is tapped — reveals the board itself for
// the rest of this visit.
export function confirmLanding() {
  localLandingSeen = true;
}

// Leaving the finish screen early instead of waiting out FINISH_VIEW_MS.
export function skipToBoard() {
  rt.returnToBoard();
}

export function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

export function getFinishDataUrl() {
  return els.finishCanvas.toDataURL("image/png");
}

function tick() {
  render();
}

function render() {
  currentCanDraw = false;
  const now = rt.serverNow();
  const state = session.state || "board";

  if (state !== lastServerState) {
    if (state === "board") {
      pickBoardPrompt(); // fresh prompt each time this station returns to idle
      boardScrolled = false; // re-center on what's already there, once, per visit
      localLandingSeen = false; // show the attract splash again for the next visitor
    }
    if (state === "lobby") {
      localOnboardingSeen = false;
      localAlertSeen = false;
      clearTimeout(alertTimer);
      alertTimer = null;
      // The canvas itself clears via room/strokes being removed (each
      // removal fires the same listener undo() uses), but that doesn't
      // touch myRedoStack — without this, "Redo" could resurrect a stroke
      // from the round that just ended onto the fresh canvas.
      myStrokes = [];
      myRedoStack = [];
      onDuetStartCallbacks.forEach((cb) => cb());
      unlockAudio();
      playChime(660);
    }
    lastServerState = state;
  }

  if (state === "board") {
    finishShown = false;
    lastTurnRole = null;
    lastTickSecond = null;
    updateBoard(); // both-active trigger check runs regardless of the landing splash
    if (!localLandingSeen) {
      showScreen("landing");
      return;
    }
    showScreen("board");
    return;
  }

  if (state === "lobby") {
    if (!localAlertSeen) {
      showScreen("alert");
      if (!alertTimer) {
        alertTimer = setTimeout(() => {
          localAlertSeen = true;
          alertTimer = null;
        }, 2500);
      }
    } else if (!localOnboardingSeen) {
      showScreen("onboarding");
    } else {
      showScreen("lobby");
      updateLobby();
    }
    return;
  }

  // state === "countdown" covers the countdown/playing/finished sub-phases
  // too — which one is showing is derived purely from time vs now.
  if (now < session.startAt) {
    showScreen("countdown");
    updateCountdown(session.startAt - now);
    return;
  }
  if (now < session.endsAt) {
    showScreen("play");
    updatePlay(now);
    return;
  }
  showScreen("finish");
  updateFinish(now);
}

function showScreen(name) {
  if (name === currentScreenName) return;
  currentScreenName = name;
  els.screens.forEach((s) => {
    s.hidden = s.dataset.screen !== name;
  });
  if (name === "play") {
    // The canvas measures its own size on resize/orientationchange only;
    // while `#screen-play` was `hidden` it had zero size, so re-measure now
    // that it's visible. Synchronous, not requestAnimationFrame — rAF never
    // fires while a tab isn't actively composited, which would leave the
    // canvas stuck at a 1x1 fallback size forever. Reading layout geometry
    // right after toggling `hidden` forces the browser to flush layout
    // immediately, so this is accurate regardless of visibility state.
    canvasEngine.resize();
  }
  if (name === "board") {
    maybeCenterBoardView();
  }
}

// Centres the view on whatever's already been drawn, once per visit (not on
// every update — that would yank the view around while someone's actually
// browsing), gated on trailLoaded so it never fires against an empty
// placeholder just before the real content arrives a moment later.
function maybeCenterBoardView() {
  if (!boardCanvasEngine) return;
  if (!boardScrolled && trailLoaded) {
    boardScrolled = true;
    centerBoardView();
  }
  applyTransform();
}

function centerBoardView() {
  if (!els.boardViewport) return;
  const center = boardCanvasEngine.getContentCenter();
  const b = boardCanvasEngine.bounds;
  zoom = 1;
  const vpW = els.boardViewport.clientWidth || 940;
  const vpH = els.boardViewport.clientHeight || 600;
  panX = vpW / 2 - (center.x - b.minX) * zoom;
  panY = vpH / 2 - (center.y - b.minY) * zoom;
}

// Internal role identifiers stay "A"/"B" (the data model, room keys, etc.) —
// this is just the user-facing name for each.
function roleName(r) {
  return r === "A" ? "Player 1" : "Player 2";
}

function isActive(p) {
  if (!p || typeof p.lastActive !== "number") return false;
  return rt.serverNow() - p.lastActive < ACTIVE_WINDOW_MS;
}

function pickBoardPrompt() {
  const list = station.prompts;
  boardPrompt = list[Math.floor(Math.random() * list.length)];
  if (els.boardPromptText) els.boardPromptText.textContent = boardPrompt;
}

function updateBoard() {
  if (els.boardIcon) els.boardIcon.textContent = station.icon;
  if (els.boardLabel) els.boardLabel.textContent = station.label;

  const other = role === "A" ? "B" : "A";
  if (isActive(presence[role]) && isActive(presence[other])) {
    rt.tryTriggerDuet();
  }
}

function applyTransform() {
  if (els.boardCanvasWrap) {
    els.boardCanvasWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
}

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Rescales around a fixed on-screen point (the pinch midpoint) rather than
// the origin, so the content under your fingers stays under your fingers
// as you pinch — the same way every other pinch-zoom surface behaves.
function applyZoomAnchored(newZoom, midClient) {
  const vpRect = els.boardViewport.getBoundingClientRect();
  const mx = midClient.x - vpRect.left;
  const my = midClient.y - vpRect.top;
  const contentX = (mx - panX) / zoom;
  const contentY = (my - panY) / zoom;
  zoom = newZoom;
  panX = mx - contentX * zoom;
  panY = my - contentY * zoom;
  applyTransform();
}

function onViewportPointerDown(e) {
  // Only touch pans/pinch-zooms the view — pen/mouse is drawing input,
  // handled entirely by BoardCanvas's own listeners on this same element.
  if (e.pointerType !== "touch") return;
  trackedPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (trackedPointers.size === 2) {
    const pts = [...trackedPointers.values()];
    pinchStartDist = pointerDistance(pts[0], pts[1]) || 1;
    pinchStartZoom = zoom;
  }
}

function onViewportPointerMove(e) {
  if (!trackedPointers.has(e.pointerId)) return;
  const prev = trackedPointers.get(e.pointerId);
  const curr = { x: e.clientX, y: e.clientY };
  trackedPointers.set(e.pointerId, curr);
  const pts = [...trackedPointers.values()];

  if (pts.length === 2) {
    e.preventDefault();
    const dist = pointerDistance(pts[0], pts[1]) || 1;
    const newZoom = clampZoom(pinchStartZoom * (dist / pinchStartDist));
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    applyZoomAnchored(newZoom, mid);
  } else if (pts.length === 1) {
    e.preventDefault();
    panX += curr.x - prev.x;
    panY += curr.y - prev.y;
    applyTransform();
  }
}

function onViewportPointerUp(e) {
  if (!trackedPointers.has(e.pointerId)) return;
  trackedPointers.delete(e.pointerId);
  if (trackedPointers.size < 2) {
    pinchStartDist = 0; // ends the pinch; a lone remaining pointer just resumes as a pan
  }
}

function setPill(el, p, round) {
  if (!el) return;
  const isReady = !!(p && p.readyRound === round);
  el.classList.remove("gone", "here", "ready");
  el.classList.add(!p ? "gone" : isReady ? "ready" : "here");
}

function updateLobby() {
  const round = typeof session.round === "number" ? session.round : 0;
  const other = role === "A" ? "B" : "A";
  setPill(els.pillYou, presence[role], round);
  setPill(els.pillPartner, presence[other], round);
  const aReady = !!(presence.A && presence.A.readyRound === round);
  const bReady = !!(presence.B && presence.B.readyRound === round);
  if (aReady && bReady) {
    rt.tryStartCountdown();
  }
}

function updateCountdown(msLeft) {
  els.countdownNumber.textContent = String(Math.max(1, Math.ceil(msLeft / 1000)));
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function updatePlay(now) {
  const elapsed = now - session.startAt;
  const totalLeft = session.endsAt - now;
  const turnIndex = Math.floor(elapsed / TURN_MS);
  const scheduledRole = turnIndex % 2 === 0 ? "A" : "B";
  const bothPresent = !!(presence.A && presence.B);
  const solo = !bothPresent;
  const canDraw = solo ? true : role === scheduledRole;
  currentCanDraw = canDraw;
  const turnLeft = TURN_MS - (elapsed % TURN_MS);

  els.hudTotal.textContent = fmt(totalLeft);
  els.hudWordText.textContent = (session.prompts && session.prompts[role]) || "";
  els.hudEmoji.textContent = (session.emojis && session.emojis[role]) || "";
  if (els.hudDotA) els.hudDotA.classList.toggle("gone", !presence.A);
  if (els.hudDotB) els.hudDotB.classList.toggle("gone", !presence.B);

  if (solo) {
    els.hudTurn.textContent = "It's all you now";
    hideLock();
    showToolbar(true);
  } else if (canDraw) {
    els.hudTurn.textContent = `Your turn · ${fmt(turnLeft)}`;
    hideLock();
    showToolbar(true);
  } else {
    const otherName = roleName(scheduledRole);
    els.hudTurn.textContent = `Watching ${otherName} · ${fmt(turnLeft)}`;
    showLock(otherName);
    showToolbar(false);
  }

  const turnKey = solo ? "solo" : scheduledRole;
  if (turnKey !== lastTurnRole) {
    lastTurnRole = turnKey;
    lastTickSecond = null;
    const msg = solo
      ? "You're on your own — keep going!"
      : canDraw
      ? "Your turn — draw!"
      : `Watching — ${roleName(scheduledRole)} is drawing`;
    flashBanner(msg);
    playChime(canDraw || solo ? 660 : 440);
  }

  const turnSec = Math.ceil(turnLeft / 1000);
  if (!solo && canDraw && turnSec <= 5 && turnSec > 0 && turnSec !== lastTickSecond) {
    lastTickSecond = turnSec;
    playChime(880);
  }
}

function updateFinish(now) {
  if (!finishShown) {
    finishShown = true;
    returnRequested = false;
    finishReturnAt = now + FINISH_VIEW_MS;

    const prompts = session.prompts || {};
    const emojis = session.emojis || {};
    els.revealWordA.textContent = prompts.A || "";
    els.revealEmojiA.textContent = emojis.A || "";
    els.revealWordB.textContent = prompts.B || "";
    els.revealEmojiB.textContent = emojis.B || "";

    const fctx = els.finishCanvas.getContext("2d");
    els.finishCanvas.width = els.canvasBase.width;
    els.finishCanvas.height = els.canvasBase.height;
    // Scale the display size to fit the finish card, preserving aspect
    // ratio (the base canvas's pixel buffer is devicePixelRatio-scaled and
    // much larger than any sensible on-screen size here).
    const maxW = 560;
    const maxH = 260;
    const scale = Math.min(maxW / els.finishCanvas.width, maxH / els.finishCanvas.height, 1);
    els.finishCanvas.style.width = `${els.finishCanvas.width * scale}px`;
    els.finishCanvas.style.height = `${els.finishCanvas.height * scale}px`;
    fctx.drawImage(els.canvasBase, 0, 0);
  }

  const secLeft = Math.max(0, Math.ceil((finishReturnAt - now) / 1000));
  if (els.finishCountdown) {
    els.finishCountdown.textContent = `Back to the board in ${secLeft}s`;
  }
  if (!returnRequested && now >= finishReturnAt) {
    returnRequested = true;
    rt.returnToBoard();
  }
}

function flashBanner(text) {
  els.turnBanner.textContent = text;
  els.turnBanner.classList.add("show");
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => els.turnBanner.classList.remove("show"), 1700);
}

function showLock(otherName) {
  els.lockText.textContent = `Watching — ${otherName}`;
  els.lockScrim.hidden = false;
}
function hideLock() {
  els.lockScrim.hidden = true;
}
function showToolbar(enabled) {
  els.toolbar.classList.toggle("disabled", !enabled);
}

function playChime(freq) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.28);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.3);
}

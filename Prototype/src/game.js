// Top-level state machine: message-board mode (default) vs. the duet
// drawing minigame, which triggers automatically when both stations are
// genuinely active at the same time. Also owns the synced duet timing/turn
// logic and all the screen/HUD updates that follow from it.
import * as rt from "./realtime.js";
import { DrawingCanvas } from "./canvas.js";
import { NoteComposer, renderNoteThumbnail } from "./board.js";
import { confirmDialog, showToast } from "./ui.js";
import { drawQr } from "./qr.js";
import { icon } from "./icons.js";

const TURN_MS = 30000;
// How fresh a heartbeat must be to count as "someone is using this station
// right now" for the purposes of triggering a duet.
const ACTIVE_WINDOW_MS = 9000;
// How long the finish/reveal screen stays up before auto-returning to the
// board (a "Done" button can also skip this early). Long enough to get a
// phone out and scan the QR code.
const FINISH_VIEW_MS = 45000;
// The shared copy of the drawing is capped (see the shares rule in
// firebase/database.rules.json); the export steps JPEG quality down until it
// fits.
const SHARE_IMG_MAX_SIDE = 1200;
const SHARE_IMG_MAX_CHARS = 700000;
// Size of one grid cell on the shared board canvas, in CSS px — must match
// the .board-grid gap/padding values in styles.css (checked at the one
// place that does the pixel math, see panToGridCell()).
const CELL_W = 320;
const CELL_H = 240;
const GRID_GAP = 12;
const GRID_PAD = 24;
// How many empty cells to always keep available beyond the current
// occupied extent, in every direction — this is what makes the board feel
// like it keeps growing rather than being a fixed size.
const BOARD_PAD = 2;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
// A drawing is hidden from the grid once it has been reported this many
// times (the data stays put; only its rendering changes).
const REPORT_HIDE_AT = 3;
// The compliment drawer opens for the last stretch of the duet.
const COMPLIMENT_WINDOW_MS = 30000;
// Pre-loaded on purpose: no typing, nothing that can be abused. `icon` is a
// Heroicon name; only `text` is sent to the partner.
export const COMPLIMENTS = [
  { text: "Nice one!", icon: "hand-thumb-up" },
  { text: "Love it!", icon: "heart" },
  { text: "So creative!", icon: "sparkles" },
  { text: "You're a star!", icon: "star" },
  { text: "Great teamwork!", icon: "user-group" },
  { text: "That's hilarious", icon: "face-smile" },
];

let els = null;
let station = null; // { id, label, icon, prompts, duetRole }
let role = null; // "A" | "B" — fixed by station, never claimed
let canvasEngine = null;
let boardNotes = {}; // "gx_gy" -> { strokes, t }
let composeCell = null; // { gx, gy } this device is currently drawing into, or null
let composeComposer = null; // NoteComposer for composeCell
let composeSubmitting = false; // true while this device's own post is in flight
let noteToolPrefs = { tool: "pen", color: "#232733", size: "m" };

// ---- board pan/zoom (fully custom — not native scroll — see the pointer
// handlers set up in init() for why) ----
let panX = 0;
let panY = 0;
let zoom = 1;
const trackedPointers = new Map(); // pointerId -> {x, y}, in client coords
let pinchStartDist = 0;
let pinchStartZoom = 1;
let panTravel = 0; // px dragged since the last pointer-down, so a drag that ends over a cell isn't also treated as a tap on it
let presence = {};
let session = { state: "board", round: 0 };
let myStrokes = []; // [{id, stroke}] this device's own strokes still on the duet canvas, in order
let myRedoStack = []; // strokes this device has undone, poppable to redo — cleared by any new stroke

let currentScreenName = null;
let currentCanDraw = false;
let lastServerState = null; // for detecting session.state edges (board -> lobby, etc.)
let localLandingSeen = false; // per visit: has this device tapped past the landing splash yet
let localMatchSeen = false; // per-round: has this device said yes to drawing with the other station yet
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
let onPromptChangeCallbacks = [];
let lastPromptKey = null;
let lastComplimentT = null; // t of the latest partner compliment already shown
let lastComplimentSentAt = 0;
let shareRun = 0; // bumped per finish screen so a slow upload can't paint a stale QR
let complimentBubbleTimeout = null;
let splashHeadline = ""; // the splash's current headline, so the next visit never repeats it
let boardPrompt = ""; // the question currently shown on the board — changes every time a box is added
let composePrompt = ""; // the question the box being drawn right now is answering (fixed when it was opened)
let prevNoteCount = null; // notes seen in the previous snapshot, to spot a new box being added
const heartCooldown = new Map(); // cell key -> ms timestamp of the last heart tap, to stop machine-gun tapping
let popHeartKey = null; // the box whose heart should play its pop animation on the next render
let boardScrolled = false; // per visit: has the view been scrolled to existing content yet
let trailLoaded = false; // has watchTrail delivered its first real snapshot yet
let renderedMinGX = null; // the (padded) bounds used for the grid's local origin last render
let renderedMinGY = null; // — compared against the fresh bounds each render to keep panX/panY anchored to world content, not local grid indices (see renderBoardGrid())

export async function init(domEls, stationConfig) {
  els = domEls;
  station = stationConfig;
  role = station.duetRole;
  els.landingBadge.innerHTML = icon(station.icon);
  pickSplashHeadline();

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
  rt.watchTrail(station.id, (notes) => {
    boardNotes = notes;
    trailLoaded = true;
    // A new box (anyone's) means a new question. Only a rise in the count
    // counts: the first snapshot isn't a new box, and neither is a removal.
    const noteCount = Object.keys(notes).filter((k) => parseCellKey(k)).length;
    if (prevNoteCount !== null && noteCount > prevNoteCount) {
      pickBoardPrompt(true);
      clearHiddenNotes();
    }
    prevNoteCount = noteCount;
    // Someone else filled the very cell this device is drawing into. (Not
    // when it's our own submit landing — Firebase reports that write to
    // this listener before the post's promise resolves.)
    if (composeCell && !composeSubmitting && boardNotes[cellKeyOf(composeCell.gx, composeCell.gy)]) {
      closeCompose();
      showToast("Someone just filled that spot — pick another one!");
    }
    renderBoardGrid();
  });

  // Pan/zoom is fully custom rather than native scroll: pinch-to-zoom has
  // no native equivalent for a single element, and mixing native scroll
  // (for pan) with a CSS transform (for zoom) means fighting over what
  // "the scroll position" even means once zoomed. touch-action:none on the
  // viewport (see styles.css) hands ALL gesture handling to these.
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

// This round's shared scene — both players draw the same thing, known to
// both from the start — or null if not yet available.
export function sharedPrompt() {
  const word = session.prompt;
  const emoji = session.emoji;
  return word ? { word, emoji } : null;
}

// main.js registers callbacks here (more than one — the onboarding
// carousel and the ready-button UI each need to reset independently)
// to run whenever a fresh duet round starts.
export function onDuetStart(cb) {
  onDuetStartCallbacks.push(cb);
}

// Fires whenever the round's shared scene changes (including the very first
// time it appears). The onboarding card re-renders from this rather than
// once at the start of the round: the device that triggers a round briefly
// sees its own optimistic local prompt before Firebase settles on the one
// that actually won the transaction, and the card must end up showing the
// same scene as the HUD.
export function onPromptChange(cb) {
  onPromptChangeCallbacks.push(cb);
}

// Backing out of a round (from matchmaking or mid-game). The duet needs both
// players, so this ends the round for both and sends them back to the board;
// the partner is told why (see the leftBy handling in render()).
export function leaveRound() {
  return rt.returnToBoard(role);
}

// "Let's draw!" on the match screen — accept the other station's invitation.
export function confirmMatch() {
  localMatchSeen = true;
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

// ---------- message board: shared infinite canvas ----------
// Tool prefs persist across cells (picking red pen once keeps it selected
// for the next note too) and apply immediately to whichever cell is
// currently being composed, if any.
export function setNoteTool(t) {
  noteToolPrefs.tool = t;
  if (composeComposer) composeComposer.setTool(t);
}
export function setNoteColor(c) {
  noteToolPrefs.color = c;
  if (composeComposer) composeComposer.setColor(c);
}
export function setNoteSize(s) {
  noteToolPrefs.size = s;
  if (composeComposer) composeComposer.setSize(s);
}
export function undoNote() {
  if (composeComposer) composeComposer.undo();
}
export function redoNote() {
  if (composeComposer) composeComposer.redo();
}

// HUD "+ Add" button: jumps straight to the nearest empty cell instead of
// making people hunt for one by panning/pinching around.
export function addAnswer() {
  if (composeCell) return; // already composing somewhere
  const cell = findFirstEmptyCell();
  const { minGX, minGY } = boardBounds();
  panToGridCell(cell.gx, cell.gy, minGX, minGY);
  const el = els.boardGrid.querySelector(`[data-key="${cellKeyOf(cell.gx, cell.gy)}"]`);
  startCompose(cell.gx, cell.gy, el ? el.getBoundingClientRect() : null);
}

// Compose overlay buttons (wired in main.js).
export async function requestExitCompose() {
  if (!composeCell || composeSubmitting) return;
  if (composeComposer && !composeComposer.isEmpty()) {
    const ok = await confirmDialog({
      title: "Discard this drawing?",
      message: "It hasn't been submitted yet.",
      confirmLabel: "Discard",
      cancelLabel: "Keep drawing",
      danger: true,
    });
    if (!ok) return;
  }
  closeCompose();
}

export async function submitCompose() {
  if (!composeCell || !composeComposer || composeComposer.isEmpty() || composeSubmitting) return;
  const { gx, gy } = composeCell;
  const strokes = composeComposer.exportStrokes();
  composeSubmitting = true;
  updateComposeSubmit();
  let ok = false;
  try {
    ok = await rt.postNote(station.id, cellKeyOf(gx, gy), strokes, composePrompt);
  } catch {
    ok = false; // a rejected write (permissions, network blip) counts as "not saved"
  }
  closeCompose();
  if (!ok) showToast("Couldn't save your drawing — that spot may have just been taken. Try another!");
  renderBoardGrid();
}

// Pre-loaded compliments for the last 30 seconds of the duet.
export function sendCompliment(text) {
  const now = performance.now();
  if (now - lastComplimentSentAt < 1500) return; // no spamming
  lastComplimentSentAt = now;
  const round = typeof session.round === "number" ? session.round : 0;
  rt.sendCompliment(role, round, text);
  els.complimentDock.classList.remove("open");
  flashBanner(`Sent: ${text}`);
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

function tick() {
  render();
}

function render() {
  currentCanDraw = false;
  const now = rt.serverNow();
  const state = session.state || "board";

  const promptKey = `${session.round}|${session.prompt || ""}`;
  if (promptKey !== lastPromptKey) {
    lastPromptKey = promptKey;
    onPromptChangeCallbacks.forEach((cb) => cb());
  }

  if (state !== lastServerState) {
    if (lastServerState === "board" && state !== "board") {
      // A duet got triggered while this device had a note half-drawn —
      // abandon it (the full-screen overlay would otherwise still be open
      // underneath the board when this station returns to it).
      closeCompose();
    }
    if (state === "board") {
      if (lastServerState && lastServerState !== "board" && session.leftBy && session.leftBy !== role) {
        showToast("Your partner left the round — back to the board.");
      }
      pickBoardPrompt(); // fresh prompt each time this station returns to idle
      // Coming back from a duet is a prompt change too (a plain page reload isn't).
      if (lastServerState && lastServerState !== "board") clearHiddenNotes();
      boardScrolled = false; // re-center on what's already there, once, per visit
      localLandingSeen = false; // show the attract splash again for the next visitor
      pickSplashHeadline();
    }
    if (state === "lobby") {
      localMatchSeen = false;
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
    } else if (!localMatchSeen) {
      showScreen("match");
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
    renderBoardGrid();
  }
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

// The splash alternates between a headline for this spot (waiting for your
// food / waiting to print) and a general one, and never shows the same one
// twice running.
const SPLASH_GENERAL = "Had a long day?";
function pickSplashHeadline() {
  const options = [station.splash, SPLASH_GENERAL].filter((h) => h && h !== splashHeadline);
  splashHeadline = options[Math.floor(Math.random() * options.length)] || SPLASH_GENERAL;
  els.landingTitle.textContent = splashHeadline;
}

// Picks a prompt for the board, never the one already showing. `animate` is
// for the mid-visit change after someone adds a box, so the banner visibly
// swaps instead of the text just silently changing.
function pickBoardPrompt(animate) {
  const list = station.prompts.filter((p) => p !== boardPrompt);
  const pool = list.length ? list : station.prompts;
  boardPrompt = pool[Math.floor(Math.random() * pool.length)];
  const el = els.boardPromptText;
  if (!el) return;
  el.textContent = boardPrompt;
  if (animate) {
    el.classList.remove("swap");
    void el.offsetWidth; // restart the animation if it's already running
    el.classList.add("swap");
  }
}

function updateBoard() {
  if (els.boardIcon && els.boardIcon.dataset.icon !== station.icon) {
    els.boardIcon.dataset.icon = station.icon;
    els.boardIcon.innerHTML = icon(station.icon);
  }
  if (els.boardLabel) els.boardLabel.textContent = station.label;

  const other = role === "A" ? "B" : "A";
  if (isActive(presence[role]) && isActive(presence[other])) {
    rt.tryTriggerDuet();
  }
}

// Free placement: people choose any empty cell (by tapping it) rather than
// always getting "the next" one — this IS the infinite canvas. A cell's
// key ("gx_gy") doubles as its claim: posting to that exact key is a
// transaction that aborts if it's already taken (see realtime.js), so a
// cell can never end up drawn on by two people even if they tap the same
// spot at the same instant — they can only ever add around each other.

// A cell key is only ever "gx_gy" (both integers, gx/gy can be negative) —
// written that way by this app alone. Filtering on the shape defends
// against anything else ending up under this path corrupting the grid's
// bounds (e.g. NaN from a malformed key poisoning a Math.min/max chain).
const CELL_KEY_RE = /^(-?\d+)_(-?\d+)$/;

function parseCellKey(key) {
  const m = CELL_KEY_RE.exec(key);
  return m ? { gx: Number(m[1]), gy: Number(m[2]) } : null;
}

// The actual occupied extent, unpadded — null bounds (all zero, any:false)
// if the board has no notes yet.
function occupiedExtent() {
  let minGX = 0;
  let maxGX = 0;
  let minGY = 0;
  let maxGY = 0;
  let any = false;
  for (const key of Object.keys(boardNotes)) {
    const cell = parseCellKey(key);
    if (!cell) continue;
    if (!any) {
      minGX = maxGX = cell.gx;
      minGY = maxGY = cell.gy;
      any = true;
    } else {
      if (cell.gx < minGX) minGX = cell.gx;
      if (cell.gx > maxGX) maxGX = cell.gx;
      if (cell.gy < minGY) minGY = cell.gy;
      if (cell.gy > maxGY) maxGY = cell.gy;
    }
  }
  return { minGX, maxGX, minGY, maxGY, any };
}

function boardBounds() {
  const e = occupiedExtent();
  return {
    minGX: e.minGX - BOARD_PAD,
    maxGX: e.maxGX + BOARD_PAD,
    minGY: e.minGY - BOARD_PAD,
    maxGY: e.maxGY + BOARD_PAD,
  };
}

function findFirstEmptyCell() {
  const { minGX, maxGX, minGY, maxGY } = boardBounds();
  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      if (!boardNotes[`${gx}_${gy}`]) return { gx, gy };
    }
  }
  // Unreachable in practice — BOARD_PAD always leaves empty cells around
  // the occupied extent — but fall back to the origin rather than throw.
  return { gx: 0, gy: 0 };
}

// Whenever the board's question changes, drawings that were hidden by
// community reports are erased for good and their boxes become free again.
// Until then they stay as the "hidden" placeholder, which is the signal that
// the report went through.
function clearHiddenNotes() {
  for (const [key, note] of Object.entries(boardNotes)) {
    if (!parseCellKey(key)) continue;
    const reports = typeof note.reports === "number" ? note.reports : 0;
    if (reports >= REPORT_HIDE_AT) {
      rt.clearHiddenNote(station.id, key, REPORT_HIDE_AT).catch(() => {});
    }
  }
}

function cellKeyOf(gx, gy) {
  return `${gx}_${gy}`;
}

// Tapping an empty cell opens it as a full-screen overlay (the drawing tools
// live there) rather than drawing inside the small grid cell. originRect is
// the tapped cell's on-screen rect, used only to animate the cell "growing"
// into the overlay.
function startCompose(gx, gy, originRect) {
  if (composeCell) return; // this device is already composing elsewhere
  if (boardNotes[cellKeyOf(gx, gy)]) return; // taken since the grid was drawn
  composeCell = { gx, gy };
  composeSubmitting = false;
  composePrompt = boardPrompt;
  els.composeTitle.textContent = composePrompt;
  els.composeOverlay.hidden = false;
  layoutComposeCard();
  composeComposer = new NoteComposer(els.composeCanvas, updateComposeSubmit);
  composeComposer.setTool(noteToolPrefs.tool);
  composeComposer.setColor(noteToolPrefs.color);
  composeComposer.setSize(noteToolPrefs.size);
  updateComposeSubmit();
  window.addEventListener("resize", onComposeResize);
  animateComposeOpen(originRect);
}

function closeCompose() {
  window.removeEventListener("resize", onComposeResize);
  if (composeComposer) composeComposer.destroy();
  composeComposer = null;
  composeCell = null;
  composeSubmitting = false;
  if (els.composeOverlay) els.composeOverlay.hidden = true;
}

function updateComposeSubmit() {
  els.composeSubmit.disabled = !composeComposer || composeComposer.isEmpty() || composeSubmitting;
}

function onComposeResize() {
  layoutComposeCard();
  if (composeComposer) composeComposer.resize();
}

// The drawing is stored as strokes normalized to the canvas's own size, so
// the enlarged canvas must keep the grid cell's aspect ratio or the drawing
// would stretch when it's shown back in the grid. Fit the biggest such
// rectangle into the stage (16px padding each side, see .compose-stage).
function layoutComposeCard() {
  const availW = els.composeStage.clientWidth - 32;
  const availH = els.composeStage.clientHeight - 32;
  const ratio = CELL_W / CELL_H;
  const w = Math.max(160, Math.min(availW, availH * ratio));
  els.composeCard.style.width = `${w}px`;
  els.composeCard.style.height = `${w / ratio}px`;
}

function animateComposeOpen(originRect) {
  const card = els.composeCard;
  if (!card.animate) return;
  const to = card.getBoundingClientRect();
  let from = "scale(0.9)";
  if (originRect && originRect.width && to.width) {
    const sc = originRect.width / to.width;
    const dx = originRect.left + originRect.width / 2 - (to.left + to.width / 2);
    const dy = originRect.top + originRect.height / 2 - (to.top + to.height / 2);
    from = `translate(${dx}px, ${dy}px) scale(${sc})`;
  }
  card.animate([{ transform: from, opacity: 0.6 }, { transform: "none", opacity: 1 }], {
    duration: 260,
    easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  });
}

// Pans/pinches end with a pointer-up that can land on a cell; that shouldn't
// count as tapping the cell.
function wasPan() {
  return panTravel > 8;
}

// Hearts are increment-only on purpose: the iPad is shared by everyone who
// walks up, so a per-device "you already liked this" (or toggle) would stop
// the next visitor from hearting the same drawing, or undo the last one's.
function heartCell(key) {
  const now = performance.now();
  if (now - (heartCooldown.get(key) || 0) < 600) return;
  heartCooldown.set(key, now);
  popHeartKey = key;
  rt.heartNote(station.id, key).catch(() => {
    showToast("Couldn't send that heart — try again.");
  });
}

async function reportCell(key) {
  const ok = await confirmDialog({
    title: "Report this drawing?",
    message: `Flag it if it contains profanity or anything inappropriate. Drawings are hidden once they've been reported ${REPORT_HIDE_AT} times.`,
    confirmLabel: "Report",
    danger: true,
  });
  if (!ok) return;
  try {
    await rt.reportNote(station.id, key);
    showToast("Thanks — we've flagged this drawing.");
  } catch {
    showToast("Couldn't send your report — please try again.");
  }
}

function renderBoardGrid() {
  if (!els.boardGrid) return;

  const { minGX, maxGX, minGY, maxGY } = boardBounds();
  // The grid's local (0,0) is (minGX, minGY) — CSS Grid needs *some* fixed
  // origin — but that origin shifts every time a new note pushes the
  // occupied extent (plus its BOARD_PAD margin) outward. Without this,
  // panX/panY (set in screen pixels against the *previous* origin) would
  // suddenly point at the wrong local cell and the whole board would jump
  // the moment someone posts near an edge.
  if (renderedMinGX !== null && (minGX !== renderedMinGX || minGY !== renderedMinGY)) {
    panX += (minGX - renderedMinGX) * (CELL_W + GRID_GAP) * zoom;
    panY += (minGY - renderedMinGY) * (CELL_H + GRID_GAP) * zoom;
  }
  renderedMinGX = minGX;
  renderedMinGY = minGY;
  const cols = maxGX - minGX + 1;
  const rows = maxGY - minGY + 1;
  els.boardGrid.style.gridTemplateColumns = `repeat(${cols}, ${CELL_W}px)`;
  els.boardGrid.style.gridTemplateRows = `repeat(${rows}, ${CELL_H}px)`;
  els.boardGrid.innerHTML = "";

  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      const key = cellKeyOf(gx, gy);
      const note = boardNotes[key];
      const cell = document.createElement("div");
      cell.className = "board-cell";
      cell.dataset.key = key;

      if (note) {
        const reports = typeof note.reports === "number" ? note.reports : 0;
        if (reports >= REPORT_HIDE_AT) {
          cell.classList.add("reported");
          cell.innerHTML = `<div class="reported-icon">${icon("no-symbol")}</div><div>Hidden after community reports</div><div class="reported-note">This box frees up when the next drawing is added</div>`;
          els.boardGrid.appendChild(cell);
        } else {
          cell.classList.add("filled");
          const cv = document.createElement("canvas");
          cell.appendChild(cv);
          els.boardGrid.appendChild(cell);
          renderNoteThumbnail(cv, note.strokes);
          if (typeof note.prompt === "string" && note.prompt) {
            const caption = document.createElement("div");
            caption.className = "cell-caption";
            caption.textContent = note.prompt;
            cell.appendChild(caption);
          }
          const hearts = typeof note.hearts === "number" ? note.hearts : 0;
          const heartBtn = document.createElement("button");
          heartBtn.className = "heart-btn" + (hearts > 0 ? " has-hearts" : "");
          heartBtn.innerHTML = hearts > 0 ? `${icon("heart", { solid: true })}<span>${hearts}</span>` : icon("heart");
          heartBtn.title = "Love this drawing";
          if (popHeartKey === key) {
            heartBtn.classList.add("pop");
            popHeartKey = null;
          }
          heartBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (wasPan()) return;
            heartCell(key);
          });
          cell.appendChild(heartBtn);
          const reportBtn = document.createElement("button");
          reportBtn.className = "report-btn";
          reportBtn.innerHTML = `${icon("flag")}<span>Report</span>`;
          reportBtn.title = "Report this drawing";
          reportBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (wasPan()) return;
            reportCell(key);
          });
          cell.appendChild(reportBtn);
        }
      } else {
        cell.classList.add("empty");
        const plus = document.createElement("span");
        plus.className = "board-cell-plus";
        plus.innerHTML = icon("plus");
        cell.appendChild(plus);
        cell.addEventListener("click", () => {
          if (wasPan()) return;
          startCompose(gx, gy, cell.getBoundingClientRect());
        });
        els.boardGrid.appendChild(cell);
      }
    }
  }
  applyTransform();

  // Show people what's already there before nudging them to add their own:
  // once per visit to the board (not on every update — that would yank the
  // view around while someone's actually browsing), pan/zoom to whatever's
  // already been posted instead of defaulting to the top-left corner of
  // the padded (mostly empty) bounds. Gated on trailLoaded, not just
  // "haven't centered yet" — the very first call here can happen before
  // watchTrail's first snapshot arrives, and centering on that empty,
  // wrong-shaped placeholder would burn the one shot before the real
  // content (and its real bounds) shows up moments later.
  if (!boardScrolled && trailLoaded) {
    boardScrolled = true;
    centerBoardView(minGX, minGY);
  }
}

function centerBoardView(minGX, minGY) {
  const extent = occupiedExtent();
  const targetGX = extent.any ? (extent.minGX + extent.maxGX) / 2 : 0;
  const targetGY = extent.any ? (extent.minGY + extent.maxGY) / 2 : 0;
  zoom = 1;
  panToGridCell(targetGX, targetGY, minGX, minGY);
}

// Pans (and, on the first-ever placement, resets zoom) so that grid
// position (targetGX, targetGY) — measured against a grid whose top-left
// cell is (boundsMinGX, boundsMinGY), i.e. whatever renderBoardGrid() just
// used — ends up centered in the viewport. Used both for "show me what's
// already here" on landing and for the "+ Add" button jumping to an empty
// cell.
function panToGridCell(targetGX, targetGY, boundsMinGX, boundsMinGY) {
  if (!els.boardViewport) return;
  const contentX = GRID_PAD + (targetGX - boundsMinGX) * (CELL_W + GRID_GAP) + CELL_W / 2;
  const contentY = GRID_PAD + (targetGY - boundsMinGY) * (CELL_H + GRID_GAP) + CELL_H / 2;
  const vpW = els.boardViewport.clientWidth || 940;
  const vpH = els.boardViewport.clientHeight || 600;
  panX = vpW / 2 - contentX * zoom;
  panY = vpH / 2 - contentY * zoom;
  applyTransform();
}

function applyTransform() {
  if (els.boardGrid) {
    els.boardGrid.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
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
  if (trackedPointers.size === 0) panTravel = 0;
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
    panTravel = Infinity;
    applyZoomAnchored(newZoom, mid);
  } else if (pts.length === 1) {
    e.preventDefault();
    panTravel += Math.abs(curr.x - prev.x) + Math.abs(curr.y - prev.y);
    panX += curr.x - prev.x;
    panY += curr.y - prev.y;
    applyTransform();
  }
}

function onViewportPointerUp(e) {
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
  els.hudWordText.textContent = session.prompt || "";
  els.hudEmoji.textContent = session.emoji || "";

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

  updateCompliments(now, totalLeft, solo);
}

// The compliment drawer is only there for the final stretch, and only while
// there's actually a partner to send to. Incoming ones come in through the
// partner's presence node (see realtime.sendCompliment).
function updateCompliments(now, totalLeft, solo) {
  const open = totalLeft <= COMPLIMENT_WINDOW_MS && !solo;
  els.complimentDock.hidden = !open;
  if (!open) els.complimentDock.classList.remove("open");

  const other = role === "A" ? "B" : "A";
  const c = presence[other] && presence[other].compliment;
  if (c && c.round === session.round && c.t !== lastComplimentT && now - c.t < 10000) {
    lastComplimentT = c.t;
    showCompliment(c.text, roleName(other));
  }
}

function showCompliment(text, from) {
  const el = els.complimentBubble;
  el.replaceChildren();
  el.insertAdjacentHTML("afterbegin", icon("envelope"));
  el.append(` ${from}: ${text}`); // partner-supplied text: appended as text, never parsed as HTML
  el.hidden = false;
  el.classList.remove("show"); // restart the pop-in if one is already showing
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(complimentBubbleTimeout);
  complimentBubbleTimeout = setTimeout(() => {
    el.hidden = true;
  }, 4200);
  playChime(784);
}

function updateFinish(now) {
  if (!finishShown) {
    finishShown = true;
    returnRequested = false;
    finishReturnAt = now + FINISH_VIEW_MS;

    els.revealWord.textContent = session.prompt || "";
    els.revealEmoji.textContent = session.emoji || "";

    const fctx = els.finishCanvas.getContext("2d");
    els.finishCanvas.width = els.canvasBase.width;
    els.finishCanvas.height = els.canvasBase.height;
    // Scale the display size to fit the finish card, preserving aspect
    // ratio (the base canvas's pixel buffer is devicePixelRatio-scaled and
    // much larger than any sensible on-screen size here).
    const maxW = 460;
    const maxH = 300;
    const scale = Math.min(maxW / els.finishCanvas.width, maxH / els.finishCanvas.height, 1);
    els.finishCanvas.style.width = `${els.finishCanvas.width * scale}px`;
    els.finishCanvas.style.height = `${els.finishCanvas.height * scale}px`;
    fctx.drawImage(els.canvasBase, 0, 0);
    prepareShare();
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

// The drawing as a JPEG on a white background (the duet canvas itself is
// transparent, with white only coming from CSS, and erased areas are holes),
// scaled down and re-encoded until it fits the share size cap.
function exportShareImage() {
  const src = els.canvasBase;
  const scale = Math.min(1, SHARE_IMG_MAX_SIDE / Math.max(src.width, src.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0, out.width, out.height);
  for (const quality of [0.88, 0.75, 0.6, 0.45, 0.3]) {
    const url = out.toDataURL("image/jpeg", quality);
    if (url.length <= SHARE_IMG_MAX_CHARS) return url;
  }
  return null;
}

// Uploads a copy of the finished drawing and shows a QR code linking to it
// (share.html), so either player can scan it and save the image on their own
// phone. Both devices do this with the same id (round + the round's token),
// so they end up showing the same code.
async function prepareShare() {
  const run = ++shareRun;
  els.shareQr.hidden = true;
  els.shareStatus.hidden = false;
  els.shareStatus.textContent = "Preparing your link…";
  try {
    const img = exportShareImage();
    if (!img) throw new Error("image too large");
    const id = `${session.round}_${session.token || Math.random().toString(36).slice(2, 10)}`;
    const saved = await rt.uploadShare(id, {
      img,
      prompt: session.prompt || "",
      emoji: session.emoji || "",
      t: Date.now(),
    });
    if (!saved) throw new Error("upload failed");
    const link = new URL(`share.html?id=${encodeURIComponent(id)}`, location.href).href;
    await drawQr(els.shareQr, link, 200);
    if (run !== shareRun) return;
    els.shareQr.hidden = false;
    els.shareStatus.hidden = true;
  } catch {
    if (run !== shareRun) return;
    els.shareStatus.textContent = "Couldn't make a download link this time.";
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

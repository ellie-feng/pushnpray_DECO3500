// Top-level state machine: message-board mode (default) vs. the duet
// drawing minigame, which triggers automatically when both stations are
// genuinely active at the same time. Also owns the synced duet timing/turn
// logic and all the screen/HUD updates that follow from it.
import * as rt from "./realtime.js";
import { DrawingCanvas } from "./canvas.js";
import { NoteComposer, renderNoteThumbnail } from "./board.js";

const TURN_MS = 30000;
// How fresh a heartbeat must be to count as "someone is using this station
// right now" for the purposes of triggering a duet.
const ACTIVE_WINDOW_MS = 9000;
// How long the finish/reveal screen stays up before auto-returning to the
// board (a "Done" button can also skip this early).
const FINISH_VIEW_MS = 10000;
// Size of one grid cell on the shared board canvas, in CSS px — must match
// the .board-grid gap/padding values in styles.css (checked at the one
// place that does the pixel math, see scrollToLatest()).
const CELL_W = 220;
const CELL_H = 160;
const GRID_GAP = 12;
const GRID_PAD = 24;

let els = null;
let station = null; // { id, label, icon, prompts, duetRole }
let role = null; // "A" | "B" — fixed by station, never claimed
let canvasEngine = null;
let boardNotes = {}; // "<index>" -> { strokes, t } — answers fill in posting order
let composeIndex = null; // index this device is currently drawing into, or null
let composeComposer = null; // NoteComposer for composeIndex
let noteToolPrefs = { tool: "pen", color: "#232733", size: "m" };
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
  rt.watchTrail(station.id, (notes) => {
    boardNotes = notes;
    trailLoaded = true;
    // Don't tear down a cell this device is actively drawing into just
    // because the shared list changed elsewhere — see renderBoardGrid().
    if (composeIndex === null) renderBoardGrid();
  });

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

// ---------- message board: chronological shared gallery ----------
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
    if (lastServerState === "board" && state !== "board") {
      // A duet got triggered while this device had a note half-drawn —
      // abandon it rather than let renderBoardGrid() try to resurrect a
      // composer bound to a canvas that's about to be torn down.
      composeIndex = null;
      composeComposer = null;
    }
    if (state === "board") {
      pickBoardPrompt(); // fresh prompt each time this station returns to idle
      boardScrolled = false; // re-scroll to the latest content, once, per visit
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

// Answers fill the grid in posting order, left to right then wrapping —
// no free placement any more. A note's key is just its index as a string
// ("0", "1", "2", ...), which also doubles as its claim: posting to that
// exact key is a transaction that aborts if it's already taken (see
// realtime.js), so the "next" cell can never end up claimed twice even if
// two devices somehow tapped it at the same instant.
function noteCount() {
  return Object.keys(boardNotes).length;
}

// How many columns fit the current viewport width, so the gallery only
// ever needs to scroll vertically (like a feed) rather than needing both
// scroll directions.
function computeCols() {
  const vp = els.boardViewport;
  const width = vp && vp.clientWidth > 0 ? vp.clientWidth : 940;
  return Math.max(1, Math.floor((width - 2 * GRID_PAD + GRID_GAP) / (CELL_W + GRID_GAP)));
}

function startCompose(index) {
  if (composeIndex !== null) return; // this device is already composing elsewhere
  if (boardNotes[String(index)]) return; // taken since the grid was drawn
  composeIndex = index;
  renderBoardGrid();
}

function cancelCompose() {
  composeIndex = null;
  composeComposer = null;
  renderBoardGrid();
}

async function postCompose() {
  if (composeIndex === null || !composeComposer || composeComposer.isEmpty()) return;
  const index = composeIndex;
  const strokes = composeComposer.exportStrokes();
  composeIndex = null;
  composeComposer = null;
  try {
    await rt.postNote(station.id, String(index), strokes);
  } catch {
    // A rejected transaction (permission denied, a network blip) would
    // otherwise skip the render below entirely, leaving a stale
    // "composing" cell on screen with Cancel/Post buttons wired to a
    // composer that no longer exists. Falling through to renderBoardGrid()
    // reverts the cell to its "+" state either way — honest, since the
    // note wasn't actually saved.
  }
  // Whether this device's own transaction won the slot, someone else's did
  // in the meantime, or it failed outright, re-render from whatever
  // boardNotes ends up being once the watchTrail listener catches up.
  renderBoardGrid();
}

function renderBoardGrid() {
  if (!els.boardGrid) return;
  if (els.noteToolbar) els.noteToolbar.classList.toggle("disabled", composeIndex === null);

  const count = noteCount();
  const cols = computeCols();
  els.boardGrid.style.gridTemplateColumns = `repeat(${cols}, ${CELL_W}px)`;
  // No grid-template-rows — the row count isn't known ahead of time since
  // the gallery only ever grows. grid-auto-rows gives every implicitly
  // created row a fixed height instead (cells have no height of their own
  // otherwise — their canvas is absolutely positioned and doesn't
  // contribute to layout, so rows would collapse to ~0).
  els.boardGrid.style.gridAutoRows = `${CELL_H}px`;
  els.boardGrid.innerHTML = "";

  // 0..count-1 are finished answers, in the order they were posted;
  // index `count` is always the single open "+" slot.
  for (let i = 0; i <= count; i++) {
    const note = boardNotes[String(i)];
    const cell = document.createElement("div");
    cell.className = "board-cell";

    if (note) {
      cell.classList.add("filled");
      const cv = document.createElement("canvas");
      cell.appendChild(cv);
      els.boardGrid.appendChild(cell);
      renderNoteThumbnail(cv, note.strokes);
    } else if (composeIndex === i) {
      cell.classList.add("composing");
      const cv = document.createElement("canvas");
      cell.appendChild(cv);
      const actions = document.createElement("div");
      actions.className = "board-cell-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", cancelCompose);
      const postBtn = document.createElement("button");
      postBtn.className = "btn btn-primary";
      postBtn.textContent = "Post";
      postBtn.addEventListener("click", postCompose);
      actions.appendChild(cancelBtn);
      actions.appendChild(postBtn);
      cell.appendChild(actions);
      els.boardGrid.appendChild(cell);
      composeComposer = new NoteComposer(cv);
      composeComposer.setTool(noteToolPrefs.tool);
      composeComposer.setColor(noteToolPrefs.color);
      composeComposer.setSize(noteToolPrefs.size);
    } else {
      // This is only ever the i === count slot — the one open spot.
      cell.classList.add("next");
      const plus = document.createElement("span");
      plus.className = "board-cell-plus";
      plus.textContent = "+";
      cell.appendChild(plus);
      cell.addEventListener("click", () => startCompose(i));
      els.boardGrid.appendChild(cell);
    }
  }

  // Show people what's already there before nudging them to add their own:
  // once per visit to the board (not on every update — that would yank the
  // scroll position around while someone's actually browsing), scroll to
  // the latest answers instead of defaulting to the top of a long gallery.
  // Gated on trailLoaded, not just "haven't scrolled yet" — the very first
  // call here can happen before watchTrail's first snapshot arrives, and
  // scrolling based on that empty placeholder would burn the one shot
  // before the real content (and its real count) arrives moments later.
  if (!boardScrolled && trailLoaded) {
    boardScrolled = true;
    scrollToLatest();
  }
}

function scrollToLatest() {
  const vp = els.boardViewport;
  if (!vp) return;
  // Scrolling to the bottom (not a specific cell's offset) is simplest and
  // correct here: the grid only ever grows downward, so "all the way down"
  // always means "the newest answers and the + slot", the same way opening
  // a chat lands you on the most recent messages.
  vp.scrollTop = vp.scrollHeight;
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

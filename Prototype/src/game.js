// Game state machine: role, presence, synced session timing, turn logic,
// and all the screen/HUD updates that follow from it.
import * as rt from "./realtime.js";
import { DrawingCanvas } from "./canvas.js";

const TURN_MS = 30000;

let els = null;
let role = null;
let canvasEngine = null;
let presence = {};
let session = { state: "lobby", round: 0 };
let myStrokeIds = [];

let localActive = false; // becomes true once onboarding is done
let currentScreenName = null;
let currentCanDraw = false;
let lastTurnRole = null;
let lastTickSecond = null;
let finishShown = false;
let bannerTimeout = null;
let audioCtx = null;

export async function init(domEls) {
  els = domEls;

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
      myStrokeIds.push(id);
      canvasEngine.registerOwnStroke(id, stroke);
    },
  });

  role = await rt.claimRole();
  if (!role) return false;
  canvasEngine.setMyRole(role);

  // Make sure a round (with prompts already picked) exists before we ever
  // show onboarding — that's what lets onboarding introduce the player's
  // actual word instead of a generic teaser.
  session = (await rt.ensureRound()) || session;

  rt.watchPresence((p) => {
    presence = p;
  });
  rt.watchSession((s) => {
    session = s || { state: "lobby", round: 0 };
  });
  rt.watchStrokes(
    (id, stroke) => canvasEngine.addStrokeIfNew(id, stroke),
    (id) => {
      canvasEngine.removeStroke(id);
      myStrokeIds = myStrokeIds.filter((x) => x !== id);
    }
  );
  rt.watchLive("A", (data) => {
    if (role !== "A") canvasEngine.setRemoteLive("A", data);
  });
  rt.watchLive("B", (data) => {
    if (role !== "B") canvasEngine.setRemoteLive("B", data);
  });

  setInterval(tick, 100);
  return true;
}

export function myRole() {
  return role;
}

// This round's prompt for the local player, or null if not yet available.
export function myPrompt() {
  const word = session.prompts && session.prompts[role];
  const emoji = session.emojis && session.emojis[role];
  return word ? { word, emoji } : null;
}

export function enterLobby() {
  localActive = true;
}

// "Play again": stop auto-managing screens so the shared session flipping
// back to "lobby" doesn't jump straight past onboarding to the ready
// screen. main.js pairs this with showing the onboarding screen itself.
export function exitToOnboarding() {
  localActive = false;
  currentScreenName = null;
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
  const id = myStrokeIds.pop();
  if (id) rt.removeStroke(id);
}
export function markReady() {
  const round = typeof session.round === "number" ? session.round : 0;
  rt.markReady(role, round);
}

export function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

export async function playAgain() {
  finishShown = false;
  lastTurnRole = null;
  lastTickSecond = null;
  currentScreenName = null;
  myStrokeIds = [];
  canvasEngine.clearAll();
  await rt.resetSession();
}

export function getFinishDataUrl() {
  return els.finishCanvas.toDataURL("image/png");
}

function tick() {
  render();
}

function render() {
  if (!localActive) return;
  currentCanDraw = false;
  const now = rt.serverNow();
  const state = session.state;

  if (!state || state === "lobby") {
    // Every game cycle passes through "lobby" on *every* client (it's
    // shared session state), so this is the reliable place to clear
    // per-round flags — not just in playAgain(), which only runs on the
    // device that tapped the button.
    finishShown = false;
    lastTurnRole = null;
    lastTickSecond = null;
    showScreen("lobby");
    updateLobby();
    return;
  }
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
  updateFinish();
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
    // that it's visible. Do this synchronously, not via requestAnimationFrame:
    // rAF never fires while a tab isn't actively composited (e.g. briefly
    // backgrounded), which would leave the canvas stuck at a 1x1 fallback
    // size forever. Reading layout geometry right after toggling `hidden`
    // forces the browser to flush layout immediately, so this is accurate
    // regardless of visibility/compositing state.
    canvasEngine.resize();
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

// Internal role identifiers stay "A"/"B" (the data model, room keys, etc.) —
// this is just the user-facing name for each.
function roleName(r) {
  return r === "A" ? "Player 1" : "Player 2";
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

function updateFinish() {
  if (finishShown) return;
  finishShown = true;
  const prompts = session.prompts || {};
  const emojis = session.emojis || {};
  els.revealWordA.textContent = prompts.A || "";
  els.revealEmojiA.textContent = emojis.A || "";
  els.revealWordB.textContent = prompts.B || "";
  els.revealEmojiB.textContent = emojis.B || "";

  const fctx = els.finishCanvas.getContext("2d");
  els.finishCanvas.width = els.canvasBase.width;
  els.finishCanvas.height = els.canvasBase.height;
  // Scale the display size to fit the finish card, preserving aspect ratio
  // (the base canvas's pixel buffer is devicePixelRatio-scaled and much
  // larger than any sensible on-screen size here).
  const maxW = 560;
  const maxH = 280;
  const scale = Math.min(maxW / els.finishCanvas.width, maxH / els.finishCanvas.height, 1);
  els.finishCanvas.style.width = `${els.finishCanvas.width * scale}px`;
  els.finishCanvas.style.height = `${els.finishCanvas.height * scale}px`;
  fctx.drawImage(els.canvasBase, 0, 0);
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

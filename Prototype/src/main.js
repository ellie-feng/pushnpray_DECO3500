// Boot + all the plain-UI wiring: the landing splash, the message-board
// screen (prompt, shared grid gallery), the single-page onboarding, the
// press-and-hold ready button, and the duet toolbar. Game/timer/canvas
// logic — including the grid itself — lives in game.js.
import * as game from "./game.js";
import { getStationFromUrl, STATIONS } from "./stations.js";
import { confirmDialog } from "./ui.js";

const els = {
  screens: document.querySelectorAll(".screen"),

  // landing
  screenLanding: document.getElementById("screen-landing"),

  // board
  boardIcon: document.getElementById("board-icon"),
  boardLabel: document.getElementById("board-label"),
  boardPromptText: document.getElementById("board-prompt-text"),
  boardAddBtn: document.getElementById("board-add-btn"),
  composeOverlay: document.getElementById("compose-overlay"),
  composeTitle: document.getElementById("compose-title"),
  composeStage: document.getElementById("compose-stage"),
  composeCard: document.getElementById("compose-card"),
  composeCanvas: document.getElementById("compose-canvas"),
  composeExit: document.getElementById("compose-exit"),
  composeSubmit: document.getElementById("compose-submit"),
  boardViewport: document.getElementById("board-viewport"),
  boardGrid: document.getElementById("board-grid"),
  noteToolbar: document.getElementById("note-toolbar"),
  noteSwatches: document.getElementById("note-swatches"),
  noteUndoBtn: document.getElementById("note-undo-btn"),
  noteRedoBtn: document.getElementById("note-redo-btn"),

  // onboarding
  onboardingCard: document.getElementById("onboarding-card"),
  onboardingNext: document.getElementById("onboarding-next"),

  // match ("someone's at the other station")
  matchYouIcon: document.getElementById("match-you-icon"),
  matchYouLabel: document.getElementById("match-you-label"),
  matchThemIcon: document.getElementById("match-them-icon"),
  matchThemLabel: document.getElementById("match-them-label"),
  matchTitle: document.getElementById("match-title"),
  matchText: document.getElementById("match-text"),
  matchYes: document.getElementById("match-yes"),
  matchNo: document.getElementById("match-no"),

  // lobby
  pillYou: document.getElementById("pill-you"),
  pillPartner: document.getElementById("pill-partner"),
  readyBtn: document.getElementById("ready-btn"),
  readyRingFill: document.getElementById("ready-ring-fill"),
  readyLabel: document.getElementById("ready-label"),

  countdownNumber: document.getElementById("countdown-number"),

  hudWordText: document.getElementById("hud-word-text"),
  hudEmoji: document.getElementById("hud-emoji"),
  hudTotal: document.getElementById("hud-total"),
  hudTurn: document.getElementById("hud-turn"),
  exitBtn: document.getElementById("exit-btn"),
  complimentDock: document.getElementById("compliment-dock"),
  complimentList: document.getElementById("compliment-list"),
  complimentToggle: document.getElementById("compliment-toggle"),
  complimentBubble: document.getElementById("compliment-bubble"),

  canvasBase: document.getElementById("canvas-base"),
  canvasLive: document.getElementById("canvas-live"),
  turnBanner: document.getElementById("turn-banner"),
  lockScrim: document.getElementById("lock-scrim"),
  lockText: document.getElementById("lock-text"),
  toolbar: document.getElementById("toolbar"),
  swatches: document.getElementById("swatches"),
  undoBtn: document.getElementById("undo-btn"),
  redoBtn: document.getElementById("redo-btn"),

  finishCanvas: document.getElementById("finish-canvas"),
  finishCountdown: document.getElementById("finish-countdown"),
  shareQr: document.getElementById("share-qr"),
  shareStatus: document.getElementById("share-status"),
  revealWord: document.getElementById("reveal-word"),
  revealEmoji: document.getElementById("reveal-emoji"),
  doneBtn: document.getElementById("done-btn"),

  setupList: document.getElementById("setup-list"),
};

const COLORS = [
  "#232733",
  "#ffffff",
  "#ff5a5f",
  "#ff9f43",
  "#ffd23f",
  "#3ddc84",
  "#4d96ff",
  "#8e5bff",
  "#8a5a3d",
  "#ff8fd6",
];

function buildSwatches(container, onPick) {
  container.innerHTML = "";
  COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "swatch" + (i === 0 ? " active" : "");
    b.style.setProperty("--swatch-color", c);
    b.addEventListener("click", () => {
      container.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      b.classList.add("active");
      onPick(c);
    });
    container.appendChild(b);
  });
}

function wireToolButtons(container, onTool) {
  container.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onTool(btn.dataset.tool);
    });
  });
}

function wireSizeButtons(container, onSize) {
  container.querySelectorAll(".size-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".size-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onSize(btn.dataset.size);
    });
  });
}

// ---------- leaving a round ----------
// From the matchmaking screens (alert / onboarding / lobby / countdown) it's
// a single tap; mid-game it asks first, since it ends the round for the
// partner too.
document.querySelectorAll("[data-leave]").forEach((btn) => {
  btn.addEventListener("click", () => game.leaveRound());
});
els.exitBtn.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Leave the round?",
    message: "This ends the drawing for your partner too, and you'll both go back to the board.",
    confirmLabel: "Leave",
    cancelLabel: "Keep drawing",
    danger: true,
  });
  if (ok) game.leaveRound();
});

// ---------- match: there's a real person at the other station ----------
// Each iPad is permanently one station, so who's on the other end is fixed
// and this can be filled in once at boot rather than per round.
function renderMatch(station) {
  const other = Object.values(STATIONS).find((s) => s.duetRole !== station.duetRole);
  els.matchYouIcon.textContent = station.icon;
  els.matchYouLabel.textContent = `You · ${station.label}`;
  els.matchThemIcon.textContent = other.icon;
  els.matchThemLabel.textContent = other.label;
  els.matchTitle.textContent = `Someone's at the ${other.label}! 👋`;
  els.matchText.textContent = `There's a real person at the ${other.label} right now. Wanna draw something together?`;
}
els.matchYes.addEventListener("click", () => game.confirmMatch());
els.matchNo.addEventListener("click", () => game.leaveRound());

// ---------- onboarding: one page, the scene front and centre ----------
function renderOnboarding() {
  const p = game.sharedPrompt();
  const icon = p ? p.emoji : "🎨";
  const scene = p ? p.word : "Loading your mission&hellip;";
  els.onboardingCard.innerHTML = `
    <div class="ob-icon">${icon}</div>
    <p class="ob-eyebrow">Your mission, should you choose to doodle it</p>
    <h2 class="ob-question">${scene}</h2>
    <ul class="ob-rules">
      <li><span class="ob-rule-icon">🎨</span><span>One canvas, two artists. You're sketching this <strong>together</strong>, live.</span></li>
      <li><span class="ob-rule-icon">⏱️</span><span>2 minutes, 30-second turns. Player 1 goes, then Player 2, then round again.</span></li>
      <li><span class="ob-rule-icon">👀</span><span>Not your turn? Sit back and watch the magic happen.</span></li>
      <li><span class="ob-rule-icon">💌</span><span>Last 30 seconds: send your partner some love.</span></li>
    </ul>`;
}

els.onboardingNext.addEventListener("click", () => {
  game.confirmOnboarding();
});

// Re-rendered whenever the round's scene changes, not just once when the
// round starts, so it can never disagree with the HUD (see game.onPromptChange).
game.onPromptChange(renderOnboarding);

// ---------- press-and-hold ready ----------
const HOLD_MS = 1300;
const RING_CIRC = 2 * Math.PI * 54;
els.readyRingFill.style.strokeDasharray = `${RING_CIRC}`;
els.readyRingFill.style.strokeDashoffset = `${RING_CIRC}`;

let holding = false;
let holdStart = 0;
let holdRAF = null;
let isReady = false;

function setRing(progress) {
  els.readyRingFill.style.strokeDashoffset = `${RING_CIRC * (1 - progress)}`;
}

function holdTick() {
  const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
  setRing(p);
  if (p >= 1) {
    completeReady();
    return;
  }
  holdRAF = requestAnimationFrame(holdTick);
}

function completeReady() {
  holding = false;
  isReady = true;
  els.readyBtn.classList.add("is-ready");
  els.readyLabel.innerHTML = "Locked in!<br>Waiting&hellip;";
  game.markReady();
}

function resetReadyUI() {
  isReady = false;
  els.readyBtn.classList.remove("is-ready");
  els.readyLabel.innerHTML = "Hold to<br>lock in";
  setRing(0);
}

function startHold(e) {
  if (isReady) return;
  e.preventDefault();
  game.unlockAudio();
  holding = true;
  holdStart = performance.now();
  holdTick();
}

function cancelHold() {
  if (isReady || !holding) return;
  holding = false;
  cancelAnimationFrame(holdRAF);
  setRing(0);
}

els.readyBtn.addEventListener("pointerdown", startHold);
els.readyBtn.addEventListener("pointerup", cancelHold);
els.readyBtn.addEventListener("pointerleave", cancelHold);
els.readyBtn.addEventListener("pointercancel", cancelHold);

game.onDuetStart(resetReadyUI);

// ---------- confetti (the "you're both here!" alert) ----------
const CONFETTI_COLORS = ["#ff5a5f", "#ff9f43", "#ffd23f", "#3ddc84", "#4d96ff", "#8e5bff", "#ff8fd6"];

function spawnConfetti() {
  const host = document.getElementById("screen-alert");
  if (!host) return;
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  host.appendChild(layer);
  for (let i = 0; i < 44; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.setProperty("--c", CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]);
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.setProperty("--dx", `${(Math.random() * 2 - 1) * 160}px`);
    piece.style.setProperty("--rot", `${Math.random() * 720 - 360}deg`);
    piece.style.animationDelay = `${Math.random() * 350}ms`;
    piece.style.animationDuration = `${1300 + Math.random() * 700}ms`;
    layer.appendChild(piece);
  }
  setTimeout(() => layer.remove(), 2600);
}

game.onDuetStart(spawnConfetti);

// ---------- duet toolbar ----------
buildSwatches(els.swatches, (c) => game.setColor(c));
wireToolButtons(els.toolbar, (t) => game.setTool(t));
wireSizeButtons(els.toolbar, (s) => game.setSize(s));
els.undoBtn.addEventListener("click", () => game.undo());
els.redoBtn.addEventListener("click", () => game.redo());

// ---------- compliments (final 30 seconds) ----------
game.COMPLIMENTS.forEach((text) => {
  const chip = document.createElement("button");
  chip.className = "btn compliment-chip";
  chip.textContent = text;
  chip.addEventListener("click", () => game.sendCompliment(text));
  els.complimentList.appendChild(chip);
});
els.complimentToggle.addEventListener("click", () => {
  game.unlockAudio();
  els.complimentDock.classList.toggle("open");
});

// ---------- finish screen ----------
els.doneBtn.addEventListener("click", () => game.skipToBoard());

// ---------- message board ----------
buildSwatches(els.noteSwatches, (c) => game.setNoteColor(c));
wireToolButtons(els.noteToolbar, (t) => game.setNoteTool(t));
wireSizeButtons(els.noteToolbar, (s) => game.setNoteSize(s));
els.noteUndoBtn.addEventListener("click", () => game.undoNote());
els.noteRedoBtn.addEventListener("click", () => game.redoNote());
els.boardAddBtn.addEventListener("click", () => game.addAnswer());
els.composeExit.addEventListener("click", () => game.requestExitCompose());
els.composeSubmit.addEventListener("click", () => game.submitCompose());

// Any real interaction on the board screen counts as "active" — this is
// the signal the both-active duet trigger watches for.
document.getElementById("screen-board").addEventListener("pointerdown", () => {
  game.unlockAudio();
  game.touchActive();
});

// ---------- landing (attract) screen ----------
// Tapping it both reveals the board and counts as activity — someone
// standing at the station interacting with it is "active" regardless of
// which screen they're looking at.
els.screenLanding.addEventListener("click", () => {
  game.unlockAudio();
  game.touchActive();
  game.confirmLanding();
});

// ---------- boot ----------
function showScreenLocal(name) {
  els.screens.forEach((s) => {
    s.hidden = s.dataset.screen !== name;
  });
}

function showSetupHelp() {
  const links = Object.keys(STATIONS)
    .map((id) => `<li><code>?station=${id}</code> — ${STATIONS[id].label}</li>`)
    .join("");
  els.setupList.innerHTML = links;
  showScreenLocal("setup");
}

async function boot() {
  const station = getStationFromUrl();
  if (!station) {
    showSetupHelp();
    return;
  }
  renderMatch(station);
  await game.init(els, station);
  // From here on, game.js's render loop owns all screen switching.
}

boot();

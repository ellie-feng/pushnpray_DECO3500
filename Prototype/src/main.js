// Boot + all the plain-UI wiring: station setup, the message-board screen
// (prompt, note composer, trail feed), the onboarding carousel, the
// press-and-hold ready button, and the duet toolbar. Game/timer/canvas
// logic lives in game.js.
import * as game from "./game.js";
import { getStationFromUrl, STATIONS } from "./stations.js";

const els = {
  screens: document.querySelectorAll(".screen"),

  // board
  boardIcon: document.getElementById("board-icon"),
  boardLabel: document.getElementById("board-label"),
  boardPromptText: document.getElementById("board-prompt-text"),
  noteCanvas: document.getElementById("note-canvas"),
  noteToolbar: document.getElementById("note-toolbar"),
  noteSwatches: document.getElementById("note-swatches"),
  noteClearBtn: document.getElementById("note-clear-btn"),
  notePostBtn: document.getElementById("note-post-btn"),
  trailList: document.getElementById("trail-list"),

  // onboarding
  onboardingCards: document.getElementById("onboarding-cards"),
  onboardingDots: document.getElementById("onboarding-dots"),
  onboardingNext: document.getElementById("onboarding-next"),

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
  hudDotA: document.getElementById("hud-dot-a"),
  hudDotB: document.getElementById("hud-dot-b"),

  canvasBase: document.getElementById("canvas-base"),
  canvasLive: document.getElementById("canvas-live"),
  turnBanner: document.getElementById("turn-banner"),
  lockScrim: document.getElementById("lock-scrim"),
  lockText: document.getElementById("lock-text"),
  toolbar: document.getElementById("toolbar"),
  swatches: document.getElementById("swatches"),
  undoBtn: document.getElementById("undo-btn"),

  finishCanvas: document.getElementById("finish-canvas"),
  finishCountdown: document.getElementById("finish-countdown"),
  revealWordA: document.getElementById("reveal-word-a"),
  revealEmojiA: document.getElementById("reveal-emoji-a"),
  revealWordB: document.getElementById("reveal-word-b"),
  revealEmojiB: document.getElementById("reveal-emoji-b"),
  saveBtn: document.getElementById("save-btn"),
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

// ---------- onboarding ----------
const ONBOARDING = [
  {
    icon: "🎨",
    title: "One shared canvas",
    body: "You and the other player are creating <strong>one drawing together</strong>, live, on the same board. Everything you both add appears for both of you instantly.",
  },
  // Index 1 is special-cased in renderOnboarding() below — it reveals this
  // device's actual word once the round has one. This fallback text only
  // shows in the unlikely case the prompt isn't loaded yet.
  {
    icon: "💭",
    title: "Your word",
    body: "You'll each get a different word, with a picture, so it works across any language. Work it into the drawing however you like.",
  },
  {
    icon: "⏱️",
    title: "Taking turns",
    body: "2:00 on the clock, in 30-second turns: Player 1, then Player 2, back and forth. Both screens always show the same time left. Not your turn? Watch what they add.",
  },
  {
    icon: "🖌️",
    title: "Your tools",
    body: "Pen, highlighter, eraser, colours and sizes are along the side. Undo removes your own last mark. Ready? Let's go.",
  },
];
let obIndex = 0;

function wordCard() {
  const p = game.myPrompt();
  if (!p) return ONBOARDING[1];
  return {
    icon: p.emoji,
    title: "Your word",
    body: `Your word is <strong>${p.word}</strong>. Try to work it into the drawing somehow — and keep an eye on what your partner is adding too, since you're building <strong>one drawing together</strong>.`,
  };
}

function renderOnboarding() {
  const card = obIndex === 1 ? wordCard() : ONBOARDING[obIndex];
  els.onboardingCards.innerHTML = `
    <div class="ob-card">
      <div class="ob-icon">${card.icon}</div>
      <h2>${card.title}</h2>
      <p>${card.body}</p>
    </div>`;
  els.onboardingDots.innerHTML = ONBOARDING.map(
    (_, i) => `<span class="dot-step${i === obIndex ? " active" : ""}"></span>`
  ).join("");
  els.onboardingNext.textContent = obIndex === ONBOARDING.length - 1 ? "Let's go" : "Next";
}

els.onboardingNext.addEventListener("click", () => {
  if (obIndex < ONBOARDING.length - 1) {
    obIndex++;
    renderOnboarding();
  } else {
    game.confirmOnboarding();
  }
});

game.onDuetStart(() => {
  obIndex = 0;
  renderOnboarding();
});

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
  els.readyLabel.innerHTML = "Ready!<br>Waiting&hellip;";
  game.markReady();
}

function resetReadyUI() {
  isReady = false;
  els.readyBtn.classList.remove("is-ready");
  els.readyLabel.innerHTML = "Hold to<br>ready up";
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

// ---------- duet toolbar ----------
buildSwatches(els.swatches, (c) => game.setColor(c));
wireToolButtons(els.toolbar, (t) => game.setTool(t));
wireSizeButtons(els.toolbar, (s) => game.setSize(s));
els.undoBtn.addEventListener("click", () => game.undo());

// ---------- finish screen ----------
els.saveBtn.addEventListener("click", () => {
  window.open(game.getFinishDataUrl(), "_blank");
});
els.doneBtn.addEventListener("click", () => game.skipToBoard());

// ---------- message board ----------
buildSwatches(els.noteSwatches, (c) => game.setNoteColor(c));
wireToolButtons(els.noteToolbar, (t) => game.setNoteTool(t));
wireSizeButtons(els.noteToolbar, (s) => game.setNoteSize(s));
els.noteClearBtn.addEventListener("click", () => game.clearNote());
els.notePostBtn.addEventListener("click", () => game.postNote());

// Any real interaction on the board screen counts as "active" — this is
// the signal the both-active duet trigger watches for.
document.getElementById("screen-board").addEventListener("pointerdown", () => {
  game.unlockAudio();
  game.touchActive();
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
  await game.init(els, station);
  // From here on, game.js's render loop owns all screen switching.
}

boot();

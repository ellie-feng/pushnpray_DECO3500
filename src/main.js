// Boot + all the plain-UI wiring (onboarding carousel, press-and-hold ready
// button, toolbar). Game/timer/canvas logic lives in game.js.
import * as game from "./game.js";

const els = {
  screens: document.querySelectorAll(".screen"),

  onboardingCards: document.getElementById("onboarding-cards"),
  onboardingDots: document.getElementById("onboarding-dots"),
  onboardingNext: document.getElementById("onboarding-next"),

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
  revealWordA: document.getElementById("reveal-word-a"),
  revealEmojiA: document.getElementById("reveal-emoji-a"),
  revealWordB: document.getElementById("reveal-word-b"),
  revealEmojiB: document.getElementById("reveal-emoji-b"),
  saveBtn: document.getElementById("save-btn"),
  againBtn: document.getElementById("again-btn"),

  retryBtn: document.getElementById("retry-btn"),
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

function buildSwatches() {
  els.swatches.innerHTML = "";
  COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "swatch" + (i === 0 ? " active" : "");
    b.style.setProperty("--swatch-color", c);
    b.addEventListener("click", () => {
      document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      b.classList.add("active");
      game.setColor(c);
    });
    els.swatches.appendChild(b);
  });
}

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
    game.enterLobby();
  }
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

// ---------- toolbar ----------
document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    game.setTool(btn.dataset.tool);
  });
});
document.querySelectorAll(".size-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".size-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    game.setSize(btn.dataset.size);
  });
});
els.undoBtn.addEventListener("click", () => game.undo());

// ---------- finish screen ----------
els.saveBtn.addEventListener("click", () => {
  window.open(game.getFinishDataUrl(), "_blank");
});
els.againBtn.addEventListener("click", async () => {
  isReady = false;
  els.readyBtn.classList.remove("is-ready");
  els.readyLabel.innerHTML = "Hold to<br>ready up";
  setRing(0);
  obIndex = 0;
  // Stop the game loop from auto-managing screens *before* resetting —
  // otherwise the shared session flipping back to "lobby" gets picked up
  // immediately and jumps straight to the ready screen, skipping onboarding
  // (and showing "waiting for partner" if the old ready state hadn't
  // cleared yet — the bug this fixes).
  game.exitToOnboarding();
  await game.playAgain(); // picks a fresh prompt for the new round
  renderOnboarding();
  showScreenLocal("onboarding");
});

els.retryBtn.addEventListener("click", () => location.reload());

// ---------- boot ----------
function showScreenLocal(name) {
  els.screens.forEach((s) => {
    s.hidden = s.dataset.screen !== name;
  });
}

async function boot() {
  buildSwatches();
  showScreenLocal("join");
  const ok = await game.init(els);
  if (!ok) {
    showScreenLocal("full");
    return;
  }
  // Rendered only now, not before init() — game.myPrompt() needs the round
  // (and its prompts) to already exist, which init() guarantees by the time
  // it resolves.
  renderOnboarding();
  showScreenLocal("onboarding");
}

boot();

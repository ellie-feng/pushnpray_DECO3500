// Thin wrapper around Firebase Realtime Database.
//
// Data model (single fixed room — only ever two players, keyed by role):
//   room/presence/{A|B}: { clientId, readyRound }   (onDisconnect -> removed)
//   room/session:         { state, round, startAt, endsAt, prompts:{A,B}, emojis:{A,B} }
//   room/strokes/{id}:    { role, tool, color, size, points:[{x,y,p}], t }
//   room/live/{A|B}:      { tool, color, size, points }   (in-progress stroke preview)
//
// Readiness is tagged with the session's `round` number rather than being a
// plain boolean: a device is "ready" only when its own readyRound equals the
// CURRENT round. This is what makes replay safe — resetSession() bumps
// `round` in the same transaction it flips state back to "lobby", so a
// leftover readyRound from the round that just finished can never satisfy
// the new round's check, no matter how the presence/session listeners
// happen to be delivered relative to each other.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  set,
  update,
  remove,
  push,
  runTransaction,
  onDisconnect,
  onChildAdded,
  onChildRemoved,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { pickTwoDistinct } from "./prompts.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ---------- server-synced clock ----------
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  serverOffset = snap.val() || 0;
});
export function serverNow() {
  return Date.now() + serverOffset;
}

// ---------- identity ----------
const clientId = (() => {
  let id = sessionStorage.getItem("pnp_client_id");
  if (!id) {
    id = "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("pnp_client_id", id);
  }
  return id;
})();

async function tryClaim(role) {
  const roleRef = ref(db, `room/presence/${role}`);
  const res = await runTransaction(roleRef, (current) => {
    if (current && current.clientId && current.clientId !== clientId) {
      return; // taken by someone else -> abort
    }
    const next = { clientId };
    // Preserve readyRound across a reclaim (e.g. a mid-lobby refresh) — it's
    // harmless either way since a stale round number just won't match the
    // current one.
    if (current && current.clientId === clientId && typeof current.readyRound === "number") {
      next.readyRound = current.readyRound;
    }
    return next;
  });
  return res.committed;
}

function armDisconnectCleanup(role) {
  onDisconnect(ref(db, `room/presence/${role}`)).remove();
  onDisconnect(ref(db, `room/live/${role}`)).remove();
}

// Claims role "A" or "B" for this device. Reclaims the same role on refresh
// (via sessionStorage). Returns null if both roles are already taken by
// someone else — i.e. the game already has two players.
export async function claimRole() {
  const saved = sessionStorage.getItem("pnp_role");
  if (saved && (await tryClaim(saved))) {
    armDisconnectCleanup(saved);
    return saved;
  }
  for (const role of ["A", "B"]) {
    if (await tryClaim(role)) {
      sessionStorage.setItem("pnp_role", role);
      armDisconnectCleanup(role);
      return role;
    }
  }
  return null;
}

// Marks this device ready *for the given round*. `round` should be the
// round number read from the current session (see myPrompt/round handling
// in game.js) — tagging it this way is what makes stale readiness from a
// previous round harmless.
export function markReady(role, round) {
  return update(ref(db, `room/presence/${role}`), { readyRound: round });
}

export function watchPresence(cb) {
  onValue(ref(db, "room/presence"), (snap) => cb(snap.val() || {}));
}

export function watchSession(cb) {
  onValue(ref(db, "room/session"), (snap) => cb(snap.val() || { state: "lobby", round: 0 }));
}

// Creates the very first round if none exists yet (picks prompts, round 1).
// A no-op if a round already exists — safe to call from every device on
// boot. Always resolves with the actual current session, whether this call
// created it or not, so the caller can read prompts immediately.
export async function ensureRound() {
  const res = await runTransaction(ref(db, "room/session"), (current) => {
    if (current && typeof current.round === "number") return; // already initialized -> abort
    const [pa, pb] = pickTwoDistinct();
    return {
      state: "lobby",
      round: 1,
      prompts: { A: pa.word, B: pb.word },
      emojis: { A: pa.emoji, B: pb.emoji },
    };
  });
  return res.snapshot.val();
}

// Moves lobby -> countdown, scheduling a synced start time. Prompts were
// already picked when the round started (ensureRound/resetSession), so this
// just flips state/timing and preserves everything else. Safe to call from
// both devices at once — the transaction ensures only the first call
// actually takes effect.
export async function tryStartCountdown() {
  await runTransaction(ref(db, "room/session"), (current) => {
    if (!current || current.state !== "lobby") return; // abort, already started
    const startAt = serverNow() + 3500;
    return {
      ...current,
      state: "countdown",
      startAt,
      endsAt: startAt + 120000,
    };
  });
}

// Starts a new round: bumps `round` and picks fresh prompts in the SAME
// transaction as flipping state back to "lobby" — a single atomic write on
// one path, not sequential set()/remove()/update() calls. That's what
// guarantees a client can never observe "lobby" while old readiness from
// the finished round could still satisfy the check (see module doc above).
export async function resetSession() {
  await runTransaction(ref(db, "room/session"), (current) => {
    const round = ((current && current.round) || 0) + 1;
    const [pa, pb] = pickTwoDistinct();
    return {
      state: "lobby",
      round,
      prompts: { A: pa.word, B: pb.word },
      emojis: { A: pa.emoji, B: pb.emoji },
    };
  });
  await remove(ref(db, "room/strokes"));
  await remove(ref(db, "room/live/A"));
  await remove(ref(db, "room/live/B"));
}

// ---------- strokes ----------
export function commitStroke(stroke) {
  const strokeRef = push(ref(db, "room/strokes"));
  set(strokeRef, stroke);
  return strokeRef.key;
}

export function removeStroke(id) {
  remove(ref(db, `room/strokes/${id}`));
}

export function watchStrokes(onAdd, onRemove) {
  const strokesRef = ref(db, "room/strokes");
  onChildAdded(strokesRef, (snap) => onAdd(snap.key, snap.val()));
  onChildRemoved(strokesRef, (snap) => onRemove(snap.key));
}

// ---------- in-progress stroke preview ----------
export function publishLive(role, data) {
  set(ref(db, `room/live/${role}`), data);
}

export function clearLive(role) {
  remove(ref(db, `room/live/${role}`));
}

export function watchLive(role, cb) {
  onValue(ref(db, `room/live/${role}`), (snap) => cb(snap.val()));
}

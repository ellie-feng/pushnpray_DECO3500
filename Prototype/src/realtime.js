// Thin wrapper around Firebase Realtime Database.
//
// Data model:
//   room/presence/{A|B}: { since, lastActive }   (onDisconnect -> removed)
//     - existence = "connected" (used for the duet's solo-override)
//     - lastActive = last heartbeat timestamp while on the board screen
//       (used to detect "someone is actually using this station right now")
//   room/session: { state, round, boardSince, startAt, endsAt,
//                    prompts:{A,B}, emojis:{A,B} }
//     - state "board"    -> default message-board mode, everyone idle
//     - state "lobby"    -> a duet round has been triggered; onboarding +
//                           hold-to-ready happen client-side during this
//     - state "countdown" -> covers the countdown/playing/finished
//                            sub-phases too; which one is showing is derived
//                            client-side purely from startAt/endsAt vs now
//   room/strokes/{id}: { role, tool, color, size, points:[{x,y,p}], t }
//   room/live/{A|B}:   { tool, color, size, points }  (in-progress duet stroke)
//   trails/{stationId}/notes/{gx_gy}: { strokes:[...], t }
//     - a shared grid, one per station: "gx_gy" is both the note's
//       position and its claim — posting is a transaction that aborts if
//       the cell is already taken, so nobody can draw over an existing
//       note, only add around it
//
// There's no role-claiming any more — a device's role is fixed by which
// station it's dedicated to (see stations.js), so there's no contention to
// resolve. Readiness is still tagged with the session's `round` number so a
// leftover ready flag from a finished round can never satisfy the next
// round's check, no matter how listeners happen to be delivered relative to
// each other.
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

// How long a board round waits, after returning to "board", before the
// both-active trigger is allowed to fire again — avoids instantly
// re-triggering a new duet while the pair is still standing there right
// after the last one ended.
const BOARD_COOLDOWN_MS = 12000;

// ---------- server-synced clock ----------
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  serverOffset = snap.val() || 0;
});
export function serverNow() {
  return Date.now() + serverOffset;
}

// ---------- presence (connection + activity heartbeat) ----------
export function initPresence(role) {
  const presRef = ref(db, `room/presence/${role}`);
  set(presRef, { since: serverNow() });
  onDisconnect(presRef).remove();
  onDisconnect(ref(db, `room/live/${role}`)).remove();
}

let lastHeartbeatWrite = 0;
// Call on real interaction (a touch/tap) while on the board screen. Cheap
// to call often — throttled internally to about one write per 2s.
export function touchActive(role) {
  const now = performance.now();
  if (now - lastHeartbeatWrite < 2000) return;
  lastHeartbeatWrite = now;
  update(ref(db, `room/presence/${role}`), { lastActive: serverNow() });
}

export function watchPresence(cb) {
  onValue(ref(db, "room/presence"), (snap) => cb(snap.val() || {}));
}

// ---------- session state machine ----------
export function watchSession(cb) {
  onValue(ref(db, "room/session"), (snap) => cb(snap.val() || { state: "board", round: 0 }));
}

// Creates the very first session if none exists yet (starts in "board").
// A no-op if a session already exists. Always resolves with the actual
// current session either way, so the caller can use it immediately.
export async function ensureSession() {
  const res = await runTransaction(ref(db, "room/session"), (current) => {
    if (current && typeof current.round === "number") return; // already initialized -> abort
    return { state: "board", round: 0, boardSince: serverNow() };
  });
  return res.snapshot.val();
}

// board -> lobby: picks fresh prompts and starts a new round, but only once
// the cooldown since the last round has elapsed. Safe to call from both
// devices at once — the transaction ensures only one call actually takes
// effect, and it silently no-ops (not an error) if conditions aren't met.
export async function tryTriggerDuet() {
  await runTransaction(ref(db, "room/session"), (current) => {
    if (!current || current.state !== "board") return; // abort: not idle
    const boardSince = current.boardSince || 0;
    if (serverNow() - boardSince < BOARD_COOLDOWN_MS) return; // abort: still cooling down
    const [pa, pb] = pickTwoDistinct();
    return {
      state: "lobby",
      round: (current.round || 0) + 1,
      prompts: { A: pa.word, B: pb.word },
      emojis: { A: pa.emoji, B: pb.emoji },
    };
  });
}

// lobby -> countdown: schedules a synced start time. Prompts were already
// picked when the round started, so this just flips state/timing. Safe to
// call from both devices at once.
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

// Back to the message board once the finish screen has had its moment.
export async function returnToBoard() {
  await runTransaction(ref(db, "room/session"), (current) => {
    if (!current || current.state === "board") return; // nothing to do
    return { state: "board", round: current.round, boardSince: serverNow() };
  });
  await remove(ref(db, "room/strokes"));
  await remove(ref(db, "room/live/A"));
  await remove(ref(db, "room/live/B"));
}

// Marks this device ready *for the given round* (see module doc above for
// why readiness is round-tagged).
export function markReady(role, round) {
  return update(ref(db, `room/presence/${role}`), { readyRound: round });
}

// ---------- duet strokes ----------
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

// ---------- duet in-progress stroke preview ----------
export function publishLive(role, data) {
  set(ref(db, `room/live/${role}`), data);
}

export function clearLive(role) {
  remove(ref(db, `room/live/${role}`));
}

export function watchLive(role, cb) {
  onValue(ref(db, `room/live/${role}`), (snap) => cb(snap.val()));
}

// ---------- message-board: shared infinite canvas ----------
// Notes live on a grid, one per station, keyed "gx_gy" — that key doubles
// as the claim: posting is a transaction that aborts if the cell is
// already occupied, so two people can never draw over the same spot (they
// can only ever add around each other). There's no per-pixel collision
// detection — the grid cell *is* the reserved region.
export async function postNote(stationId, cellKey, strokes) {
  const res = await runTransaction(ref(db, `trails/${stationId}/notes/${cellKey}`), (current) => {
    if (current) return; // already occupied -> abort
    return { strokes, t: Date.now() };
  });
  return res.committed;
}

export function watchTrail(stationId, cb) {
  onValue(ref(db, `trails/${stationId}/notes`), (snap) => {
    cb(snap.val() || {});
  });
}

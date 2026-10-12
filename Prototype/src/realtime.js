// Thin wrapper around Firebase Realtime Database.
//
// Data model:
//   room/presence/{A|B}: { since, lastActive }   (onDisconnect -> removed)
//     - existence = "connected" (used for the duet's solo-override)
//     - lastActive = last heartbeat timestamp while on the board screen
//       (used to detect "someone is actually using this station right now")
//   room/session: { state, round, boardSince, startAt, endsAt,
//                    prompt, emoji, token }
//     - token: random per round; with `round` it forms the id of the shared
//       copy of the finished drawing (see shares/ below), so both devices
//       agree on one unguessable link without talking to each other
//     - prompt/emoji: one shared scene both players draw together, known to
//       both from the start (not a secret word each answers alone)
//     - state "board"    -> default message-board mode, everyone idle
//     - state "lobby"    -> a duet round has been triggered; onboarding +
//                           hold-to-ready happen client-side during this
//     - state "countdown" -> covers the countdown/playing/finished
//                            sub-phases too; which one is showing is derived
//                            client-side purely from startAt/endsAt vs now
//   room/strokes/{id}: { role, tool, color, size, points:[{x,y,p}], t }
//   room/live/{A|B}:   { tool, color, size, points }  (in-progress duet stroke)
//   room/presence/{A|B}/compliment: { text, round, t }  (latest one sent)
//   trails/{stationId}/notes/{gx_gy}: { strokes:[...], t, prompt?, hearts?, reports? }
//   shares/{round}_{token}: { img, prompt, emoji, t }
//     - a JPEG data URL of a finished duet drawing, which the finish screen's
//       QR code links to (share.html). Write-once and readable only by exact
//       id (no listing) — see firebase/database.rules.json
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
  get,
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
import { pickOne } from "./prompts.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// How long a board round waits, after returning to "board", before the
// both-active trigger is allowed to fire again — avoids instantly
// re-triggering a new duet while the pair is still standing there right
// after the last one ended.
const BOARD_COOLDOWN_MS = 12000;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

// board -> lobby: picks a fresh shared scene and starts a new round, but
// only once the cooldown since the last round has elapsed. Safe to call
// from both devices at once — the transaction ensures only one call
// actually takes effect, and it silently no-ops (not an error) if
// conditions aren't met.
export async function tryTriggerDuet() {
  await runTransaction(ref(db, "room/session"), (current) => {
    if (!current || current.state !== "board") return; // abort: not idle
    const boardSince = current.boardSince || 0;
    if (serverNow() - boardSince < BOARD_COOLDOWN_MS) return; // abort: still cooling down
    const p = pickOne();
    return {
      state: "lobby",
      round: (current.round || 0) + 1,
      prompt: p.word,
      emoji: p.emoji,
      token: randomToken(),
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

// Back to the message board once the finish screen has had its moment — or
// early, if someone backs out. `leftBy` (a role) is recorded on a back-out so
// the other device can tell its partner left rather than the round simply
// ending; it's cleared by the next round's trigger replacing the session.
export async function returnToBoard(leftBy) {
  await runTransaction(ref(db, "room/session"), (current) => {
    if (!current || current.state === "board") return; // nothing to do
    const next = { state: "board", round: current.round, boardSince: serverNow() };
    if (leftBy) next.leftBy = leftBy;
    return next;
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

// ---------- shared copies of finished drawings ----------
const SHARE_ROOT = "shares";

// Saves a finished drawing under `id` and resolves true once a copy exists.
// Both devices call this with the same id at the end of a round; the rules
// make shares write-once, so the second write is rejected — which is fine,
// as long as the first one landed, hence the follow-up read.
export async function uploadShare(id, payload) {
  try {
    await set(ref(db, `${SHARE_ROOT}/${id}`), payload);
    return true;
  } catch {
    try {
      return (await fetchShare(id)) != null;
    } catch {
      return false;
    }
  }
}

export async function fetchShare(id) {
  const snap = await get(ref(db, `${SHARE_ROOT}/${id}`));
  return snap.val();
}

// ---------- duet compliments ----------
// Rides on the sender's own presence node (already writable, already watched
// by both devices) rather than a new path: a single "latest compliment" slot
// is all the feature needs, and it's tagged with the round so a leftover one
// from an earlier round is never mistaken for a new message.
export function sendCompliment(role, round, text) {
  return update(ref(db, `room/presence/${role}`), {
    compliment: { text, round, t: serverNow() },
  });
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
// `prompt` is the question this drawing answers — it's stored with the note
// because the board's prompt changes every time a box is added, so a box
// would otherwise lose track of what it was a reply to.
export async function postNote(stationId, cellKey, strokes, prompt) {
  const res = await runTransaction(ref(db, `trails/${stationId}/notes/${cellKey}`), (current) => {
    if (current) return; // already occupied -> abort
    const note = { strokes, t: Date.now() };
    if (prompt) note.prompt = prompt;
    return note;
  });
  return res.committed;
}

// Adds one heart to a note — same shape as reportNote below: a counter on
// the note itself, under the already-writable notes/ path, only ever called
// for notes that exist.
export async function heartNote(stationId, cellKey) {
  await runTransaction(ref(db, `trails/${stationId}/notes/${cellKey}/hearts`), (current) => {
    return (typeof current === "number" ? current : 0) + 1;
  });
}

// Adds one report to a note. Stored as a counter on the note itself (under
// the already-writable notes/ path) and only ever called for notes that
// exist — creating the counter on an empty cell would make the cell look
// occupied to postNote's transaction.
export async function reportNote(stationId, cellKey) {
  await runTransaction(ref(db, `trails/${stationId}/notes/${cellKey}/reports`), (current) => {
    return (typeof current === "number" ? current : 0) + 1;
  });
}

export function watchTrail(stationId, cb) {
  onValue(ref(db, `trails/${stationId}/notes`), (snap) => {
    cb(snap.val() || {});
  });
}

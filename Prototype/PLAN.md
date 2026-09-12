# Push'n'Pray — Shared Drawing Game

A two-iPad collaborative drawing game. Both players draw on one shared live canvas
for 2 minutes, taking alternating 30-second turns. Each player gets a different
secret one-word prompt (with a pictogram) to sneak into the drawing. When it is not
your turn, you watch the other person draw.

Runs as a static site on GitHub Pages, opened on two iPads with Apple Pencils.

---

## Locked decisions

| Area | Decision |
| --- | --- |
| Real-time backend | **Firebase Realtime Database** (free tier, built-in presence, transactions) |
| Rooms | **None** — one hard-coded room. Exactly two iPads. First to join = Player A, second = Player B. A third device sees "game in progress". |
| Disconnect mid-game | Game and the 2:00 timer **keep running**. The remaining player gets the rest of the time to themselves (turn alternation is suspended while they are alone). |
| Stack | **Vanilla JS, ES modules, no build step.** Files served directly by GitHub Pages. |
| Orientation | Landscape only; portrait shows a rotate hint. |

---

## Concept / rules the players experience

- One shared canvas, visible identically on both iPads in real time.
- **2:00 total.** Turns alternate every **0:30**: A → B → A → B (four turns, even split).
- Both iPads always show the **same total time left** and the **same turn time left**.
- On your turn: you can draw, full toolbar. Not your turn: canvas is locked, toolbar
  greyed, a clear "Watching — Player X" state, you see their strokes appear live.
- Each player has a **secret word + picture** (e.g. 🦉 owl). Work it into the drawing.
  Don't show or tell the other player. Both words are revealed when time is up.
- If the other iPad drops out, the remaining player keeps drawing for whatever time
  is left — no more turn switching until/unless the other returns.

---

## Backend: Firebase Realtime Database

### One-time setup (done once, outside the code)
1. Create a Firebase project (free "Spark" plan).
2. Add a Web App, copy the config object into `src/firebase-config.js`.
3. Enable Realtime Database, start in **locked mode**, then paste the rules below.
4. (Optional) Enable Anonymous Auth if we want per-client identity later. Not required
   for MVP.

The web config (apiKey etc.) is **public by design** — safe to commit. Access is
controlled by database rules, not by hiding the config.

### Data model

```
/room                                  (single hard-coded room)
  /presence
    /{clientId}: { role: "A" | "B", ready: bool, lastSeen: <server ts> }
                                        // onDisconnect() removes this node
  /session
    state:   "lobby" | "countdown" | "playing" | "finished"
    startAt: <server ts>               // when play begins (set at countdown)
    endsAt:  <server ts>               // startAt + 120000
    prompts: { A: "owl", B: "watch" }
  /strokes
    /{strokeId}: { role, tool, color, size, points: [[x,y,p], ...], t }
  /live
    /A: { tool, color, size, points: [...] }   // in-progress stroke, overwritten
    /B: { ... }                                 // cleared on pointer-up
  /logs                                (optional, for DECO3500 evaluation)
    /{eventId}: { type, role, t, ... }
```

Coordinates are stored **normalised 0–1** (fraction of canvas width/height) so the
two iPads render identically even if their pixel sizes differ slightly.

### Role claim (no host device)

On load, run a **transaction** on `/presence`:
- Count existing entries. 0 → claim `A`. 1 → claim `B`. 2+ → show "game in progress".
- Write `/presence/{clientId} = {role, ready:false, lastSeen: ServerValue.TIMESTAMP}`.
- Register `onDisconnect(/presence/{clientId}).remove()`.
- Persist `{clientId, role}` in `sessionStorage` so a refresh/reconnect reclaims the
  same role instead of taking the other one.

### Security rules (dev-friendly starting point)

```json
{
  "rules": {
    "room": {
      ".read": true,
      ".write": true,
      "presence": {
        "$c": { ".validate": "newData.hasChildren(['role','ready']) || !newData.exists()" }
      },
      "session": {
        "state": { ".validate": "newData.val().matches(/^(lobby|countdown|playing|finished)$/)" }
      }
    }
  }
}
```

Open read/write on one room is acceptable for a class prototype. Tighten before any
public deployment (e.g. require anonymous auth, validate stroke shape, rate-limit).

---

## Session state machine

All transitions are **transactions on `/session`**, so it doesn't matter which iPad
fires them and there's no race.

```
        ┌─────────┐   both present AND both ready        ┌───────────┐
        │  lobby  │ ───────────────────────────────────▶ │ countdown │
        └─────────┘                                      └───────────┘
             ▲                                                 │ startAt reached
             │ "Play again" (any device):                      ▼
             │  reset session→lobby, clear /strokes,      ┌───────────┐
             │  clear /live, presence.ready=false         │  playing  │
             │                                            └───────────┘
        ┌──────────┐        serverNow >= endsAt                │
        │ finished │ ◀────────────────────────────────────────┘
        └──────────┘
```

- **lobby → countdown**: triggered when `/presence` has two entries and both have
  `ready === true`. The transaction sets `state="countdown"`,
  `startAt = serverNow + 3500`, `endsAt = startAt + 120000`, and picks
  `prompts` (two distinct random words). Once in `countdown` it is locked — a late
  un-ready does not cancel it.
- **countdown → playing**: no write needed; every device flips locally when
  `serverNow >= startAt`. (Optionally one transaction stamps `state="playing"` for
  tidiness.)
- **playing → finished**: every device flips locally when `serverNow >= endsAt`; one
  transaction stamps `state="finished"` and the canvas freezes.
- **finished → lobby** ("Play again"): transaction resets `session`, removes all
  `/strokes` and `/live`, sets both `presence/*/ready = false`. Players re-onboard
  from the ready screen (onboarding cards can be skipped on replay).

---

## Timing — both clocks identical

```
offset    = value of /.info/serverTimeOffset      (updated by the SDK)
serverNow = Date.now() + offset

elapsed        = serverNow - session.startAt        // ms since play began
totalLeftMs    = session.endsAt - serverNow         // shown on both iPads
turnIndex      = floor(elapsed / 30000)             // 0,1,2,3
turnLeftMs     = 30000 - (elapsed % 30000)
scheduledRole  = (turnIndex % 2 === 0) ? "A" : "B"
```

`totalLeftMs` and `turnLeftMs` come from the same server-anchored numbers on both
devices, so the countdowns stay visually in lock-step without any tick messages.

### Whose turn is it (with the disconnect rule)

```
bothPresent = /presence has an "A" entry AND a "B" entry

if (state !== "playing")            → nobody draws
else if (!bothPresent)              → the one present player may ALWAYS draw
                                       (HUD: "You're on your own — 1:23 left",
                                        no turn banner, no turn timer)
else                               → canDraw = (myRole === scheduledRole)
```

If the missing player returns, `bothPresent` becomes true again and normal
alternation resumes from the current `elapsed` — no catch-up, no timer change.

### Turn-change feedback

- Full-bleed colour wash + big text: **"YOUR TURN — draw"** / **"WATCHING — Player A"**.
- Soft chime on every switch, and a faster tick in each turn's final 5 s.
  Audio is unlocked by the press-and-hold gesture on the ready screen (iOS needs a
  user gesture before `AudioContext` will play).

---

## Screens

### 1. Join
- Claim role via the presence transaction.
- If room already has two players: "A game is already in progress on two devices."
  with a Retry button (in case one of them actually dropped).

### 2. Onboarding (self-paced, 4 cards, swipe or Next)
1. **Shared canvas** — "You and one other person draw on the *same* board. You'll see
   each other's marks appear live."
2. **Your secret word** — "You each get a different word and a picture. Work your word
   into the drawing however you like. Don't show it or say it — the other person is
   trying to notice, not be told."
3. **Taking turns** — "2:00 on the clock. You alternate every 30 seconds:
   `A · B · A · B`. Both screens show the same time left. When the pencil isn't
   yours, just watch what they add." — with a small A/B/A/B timeline graphic.
4. **Your tools** — pen, highlighter, eraser, colours, size, undo (icons + one word
   each).

### 3. Ready up (lobby)
- Big **press-and-hold** button. A ring fills over ~1.5 s. Release early → it springs
  back to empty. Complete → a pop + checkmark, `presence.ready = true` locks in.
- Two status pills: **You** and **Partner**, each cycling
  `not here (grey) → here, reading (blue) → ready (green)`.
- Copy: "The game starts when you're both ready."
- The hold gesture also unlocks the audio context.

### 4. Countdown
- Big `3 · 2 · 1`, derived from `startAt`. Then straight into play.

### 5. Play
Layout (landscape):

```
┌──────────────────────────────────────────────────────────┐
│  🦉 owl        1:23 total  ·  Your turn 0:18       ● ●    │  ← HUD
├───────┬──────────────────────────────────────────────────┤
│ pen   │                                                  │
│ mark  │                                                  │
│ erase │                 shared canvas                    │
│ ────  │                                                  │
│ • • • │                                                  │
│ S M L │                                                  │
│ undo  │                                                  │
└───────┴──────────────────────────────────────────────────┘
```

- HUD left: your word + emoji (subtle, collapsible). HUD centre: total time left, and
  turn state / turn time left. HUD right: the two presence dots.
- **Not your turn:** canvas gets a dim scrim + lock icon, toolbar greyed and
  non-interactive, banner "Watching — Player A". Their strokes still render live.
- **Partner gone:** banner "You're on your own — finish it up", toolbar always active.

### 6. Finish
- "Time's up." Canvas freezes.
- **Both secret words revealed** side by side with their pictograms.
- Buttons: **Play again** (resets for both) · **Done**. Optional **Save image** (export
  canvas to PNG via `toBlob` + download link).

---

## Drawing engine

- Single `<canvas>` 2D context, sized to CSS box × `devicePixelRatio`, re-fit on
  resize/orientation change.
- Page/canvas CSS: `touch-action: none`, `overscroll-behavior: none`, body
  `position: fixed`, viewport `user-scalable=no` — kills scroll, pinch-zoom,
  pull-to-refresh, double-tap zoom.
- **Pointer Events**: `pointerdown/move/up/cancel`. Use `getCoalescedEvents()` on
  move for smooth high-frequency Pencil sampling. `event.pressure` → line width for
  the pen.
- **Palm rejection:** once a `pointerType === "pen"` pointer is active, ignore
  `pointerType === "touch"` pointers for the rest of that stroke.
- **Tools**
  | Tool | Behaviour |
  | --- | --- |
  | Pen | Opaque. Width = base size × pressure. Round caps/joins. |
  | Highlighter | Wide, constant width, ~35% alpha, `globalCompositeOperation = "multiply"`. |
  | Eraser | `globalCompositeOperation = "destination-out"` stroke — syncs like any other stroke; no special-casing. |
  | Colours | 8–10 swatches (black, white, red, orange, yellow, green, blue, purple, brown, pink). |
  | Size | S / M / L. |
  | Undo | Removes **your own** most recent stroke from `/strokes`; every device replays. Allowed only while you can draw. |
- **Rendering:** keep committed strokes in memory, draw each new stroke
  incrementally. Full clear + replay only on resize or undo (a 2-minute drawing is a
  few hundred strokes — cheap).
- **Sync out:** while drawing, throttle (~50 ms) writes of the whole in-progress
  point array to `/live/{myRole}`. On pointer-up, `push()` the finished stroke to
  `/strokes` and clear `/live/{myRole}`.
- **Sync in:** listen to `/strokes` `child_added` (render committed strokes, skip
  ones this device authored — already drawn) and `child_removed` (undo → replay).
  Listen to `/live/{otherRole}` (`value`) to render their in-progress stroke as a
  live preview layer.
- **Input gate:** a stroke can only *start* when `canDraw` (see turn logic) is true.

---

## Prompts

`src/prompts.js` — array of `{ word, emoji }`, concrete everyday nouns that read
without language: 

```
🦉 owl   ⌚ watch   🏠 house   🌳 tree   🐟 fish   ⛵ boat   🚗 car   🔑 key
📖 book  ⏰ clock   🍎 apple   👟 shoe   ⚽ ball   🌸 flower  🐦 bird   🪑 chair
🥄 spoon ☂️ umbrella 🎈 balloon 🪁 kite  🪜 ladder  🌉 bridge  ☁️ cloud  ❤️ heart
🍄 mushroom 👑 crown 🎸 guitar 📷 camera 💡 lightbulb 🐝 bee   🐌 snail  🌙 moon
⭐ star  ☀️ sun    🎩 hat    🕶️ sunglasses 🦋 butterfly 🍦 ice cream 🍕 pizza
🚲 bicycle ✈️ airplane 🚀 rocket 🌵 cactus 🕯️ candle 🔨 hammer 🪣 bucket 🧸 teddy
```

At `lobby → countdown`, the transaction picks two **distinct** entries at random and
writes them to `session.prompts`. Each iPad displays only its own; both shown at
finish.

---

## File structure

```
index.html
styles.css
src/
  firebase-config.js     // pasted Firebase web config (public, committed)
  main.js                // boot, screen router, wires modules together
  realtime.js            // Firebase: presence, role claim, session txns, strokes I/O
  game.js                // state machine, server-time sync, turn + solo logic
  canvas.js              // drawing engine, tools, pointer handling, render/replay
  prompts.js             // word + emoji list + pick-two
  ui/
    onboarding.js
    lobby.js             // press-and-hold ready, presence pills
    hud.js               // timers, turn banner, word chip, presence dots
    finish.js            // reveal words, play again, save image
assets/
  chime.mp3, tick.mp3, icons...
PLAN.md                  // this file
```

Deploy: repo **Settings → Pages → Deploy from branch → `main` / root**. No Actions,
no build.

---

## Build order (milestones)

1. **Shell + flow, no backend.** `index.html`, router, onboarding cards, press-and-hold
   ready interaction, HUD/finish layouts with fake data. Verify it feels right on an
   iPad in landscape.
2. **Firebase wiring.** `firebase-config.js`, `realtime.js`: role-claim transaction,
   presence with `onDisconnect`, "game in progress" path, presence pills go live
   across two devices.
3. **Session + timing.** `game.js`: `lobby → countdown → playing → finished`
   transactions, `/.info/serverTimeOffset` sync, countdown screen, both total and turn
   timers ticking in lock-step on two devices.
4. **Canvas engine, local only.** `canvas.js`: pointer input, coalesced events,
   pressure, all tools, undo, resize replay.
5. **Canvas sync + turns.** `/live` preview + `/strokes` commit/replay across devices;
   `canDraw` gate; turn banner + chime; solo-player override on disconnect.
6. **Replay + polish.** "Play again" reset, "partner left" banner, save PNG, PWA meta
   (`apple-mobile-web-app-capable`, icons, theme-color), portrait rotate hint.
7. **Optional for evaluation.** `/logs` events (ready time, strokes per player, turn
   switches, disconnects) for later analysis.

---

## Deferred / not in MVP

- Pause-and-resume on disconnect (decided against — timer runs down).
- More than two players / multiple rooms.
- Persisting finished drawings anywhere server-side.
- Auth. Anonymous auth only if rule-tightening needs it.
- Reconnect handling beyond "reclaim same role via sessionStorage".

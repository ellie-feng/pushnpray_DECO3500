# Push'n'Pray — DECO3500

A two-iPad collaborative drawing game built for DECO3500. Two players share one
live canvas for 2 minutes, taking alternating 30-second turns, each trying to
sneak a secret one-word prompt into the drawing without the other noticing.
Runs as a static site (no build step) on GitHub Pages, backed by Firebase
Realtime Database for live sync between the two devices.

## Repository structure

```
pushnpray_DECO3500/
├── Design_Proposal/            # Early-stage proposal deliverables (Weeks 1–5)
│   ├── DECO3500 PNP Team Charter.docx
│   ├── Design Proposal Script.docx
│   ├── Week 3 Domain Research.docx
│   ├── Week 5 Design Proposal Presentation.pptx
│   ├── Push n Pray_ Design Proposal Slides.pptx
│   └── Preliminary Interviews/     # First round of user interviews + protocol
│       ├── Preliminary Interview Protocol.docx
│       └── Participant B1/B2/E1/H1/L1/L2.docx (+ .txt transcript)
│
├── Design_Project_Sequence/     # Later-stage design research and testing
│   ├── Brainstorming.docx
│   ├── Idea.docx
│   ├── Field Observations.docx
│   ├── Temporary WIKI.docx
│   ├── Testing Session 1.mp4
│   └── Secondary Interviews/        # Second round of interviews + protocol
│       ├── Secondary Interview Protocol.docx
│       └── Secondary Interview E1/H1/H2/L1/L2.docx
│
├── Meeting_Minutes/             # Weekly team meeting notes
│   ├── Week 3_ 16_08 Sunday.docx
│   ├── Week 4_ 20_08 Thursday.docx
│   ├── Week 5_ 28_08 Friday.docx
│   └── Week 6_ 04_09 Friday.docx
│
├── Prototype/                   # The working app
│   ├── PLAN.md                      # Full technical spec: rules, data model,
│   │                                 #   state machine, screens, build order
│   ├── index.html
│   ├── styles.css
│   ├── firebase/
│   │   └── database.rules.json      # Realtime Database security rules
│   └── src/
│       ├── main.js                  # Boot / screen router, wires modules together
│       ├── realtime.js              # Firebase: presence, role claim, session txns
│       ├── game.js                  # State machine, server-time sync, turn logic
│       ├── canvas.js                # Drawing engine, tools, pointer handling
│       └── prompts.js               # Secret word + emoji list
│
├── Wiki_Pages/                  # Supplementary write-ups
│   ├── Design_Overview.md
│   └── Ethical_Considerations.md
│
└── README.md
```

## Folder guide

- **Design_Proposal** — the initial pitch: team charter, domain research, and the
  slides/script used to propose the project, plus the preliminary interviews that
  informed it.
- **Design_Project_Sequence** — the deeper research phase that followed: brainstorming,
  field observations, a second round of interviews, and an early usability test
  recording.
- **Meeting_Minutes** — dated notes from weekly team meetings across the project.
- **Prototype** — the actual buildable artifact: a vanilla-JS, no-build static site
  (`index.html` + `src/`) deployed via GitHub Pages, with Firebase Realtime Database
  as the sync layer between the two iPads. `PLAN.md` inside this folder is the
  source of truth for how the game works (rules, data model, screens, build order).
- **Wiki_Pages** — space reserved for a design overview and ethical considerations
  write-up (currently placeholders).

## Running the prototype

The prototype needs no build step — it's plain HTML/CSS/JS modules.

1. Add your Firebase Web App config to `Prototype/src/firebase-config.js`.
2. Enable Realtime Database on that Firebase project and apply the rules in
   `Prototype/firebase/database.rules.json`.
3. Serve `Prototype/` as a static site (e.g. GitHub Pages: **Settings → Pages →
   Deploy from branch → `main`**, or any local static server for testing).
4. Open the deployed URL on two iPads (landscape, Apple Pencil) to play.

See `Prototype/PLAN.md` for the full design and implementation spec.

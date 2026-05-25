# Quantum Maze

A browser-based maze game where the maze doesn't exist until you observe it. Every wall is a qubit in superposition. Your movement collapses quantum states one measurement at a time, using real quantum circuits running on Qiskit's `AerSimulator`.

## What's in the game

- **Per-wall non-zero superposition.** When you enter a new cell, the surrounding candidate walls go into a single entangled state `|ψ⟩ = (1/√(2^k − 1)) Σ_{x ≠ 0} |x⟩` and are measured together. The all-`SOLID` outcome has literally zero amplitude — at least one wall *must* open. Quantum mechanics, not a classical fix-up.
- **Bell-state entanglement.** ~10% of walls are paired at game start under structural constraints (at most one Bell wall per cell, none adjacent to start or exit). When you observe one, its distant partner collapses simultaneously to the same outcome. Pre-collapse, dashed purple threads on the minimap show *exactly which walls are linked*.
- **CHSH self-test panel.** Below the minimap, an independent stream of Bell measurements at varied angles accumulates the CHSH statistic `S` in the background. Once `S > 2.0` it lights up "Non-locality confirmed" — your game is *proving* its quantum claim live, not just asserting it.
- **Amplitude-bar overlay.** When the non-zero circuit fires, a small panel briefly shows `P(open)` for each candidate wall before they collapse to OPEN (cyan) or SOLID (grey). The wavefunction is visible for the moment before it isn't.
- **Honest seal-offs.** If a Bell collapse orphans the exit cell, the game ends with `★ Quantum entanglement sealed this maze.` No classical override patches it up. Restart for a fresh quantum dice roll.

## Stack

- **Frontend** — vanilla HTML/JS, no frameworks. First-person 3D maze view + top-down minimap + CHSH panel on a single page.
- **Backend** — Flask + Qiskit. One HTTP endpoint that builds and measures quantum circuits (`w_state`, `bell`, `nonzero`, `chsh`).
- **Quantum** — Qiskit 2.x with `AerSimulator`. Replace one line in `server.py` with `QiskitRuntimeService().backend(...)` and the same circuits run on real IBM hardware.

## Running it locally

You need Python 3.10+ and a modern browser.

```bash
# 1. Set up a Python environment and install deps
python -m venv .venv
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # macOS/Linux
pip install -r requirements.txt

# 2. Start the Qiskit backend (port 5000)
python server.py

# 3. In another terminal, serve the frontend statically (port 8765)
python -m http.server 8765

# 4. Open the game in your browser
#    http://localhost:8765/index.html
```

The backend logs each `POST /collapse` request — you can watch real quantum circuits being measured as you play.

## Controls

| Key / Action | Effect |
|--|--|
| ↑ | Move forward |
| ↓ | Move backward |
| ← | Turn left 90° |
| → | Turn right 90° |
| **Click a visited cell on the minimap** | Teleport there (no measurements fire — pure navigation) |
| Restart button | New maze (fresh exit-row pick, fresh Bell pairs) |

Reach the cell at the pre-picked exit row on column 14, then step east through the now-open exit wall to escape.

## Running the tests

```bash
# Backend test suite
.venv\Scripts\python -m unittest discover tests -v
```

E2E browser invariants (with the servers running and a browser DevTools console open):

```js
await fetch('/tests/e2e_invariants.js').then(r => r.text()).then(eval);
console.log(await runE2ESuite(20));
```

## Version history

| Version | Headline change |
|---|---|
| **v0.1** | Initial Quantum Maze: W-state mechanic + classical end-game repair. |
| **v0.2** | Pre-pick exit row quantumly (uniform random); per-Bell orphan repair. |
| **v0.3** | Replace W-state with per-wall non-zero superposition entangled circuit. Remove **all** classical override — wall states are now genuinely irreversible. Add minimap click-to-teleport. |
| **v0.4** | CHSH self-test panel + Bell partner threads on minimap + amplitude bars during measurement. |

Specs and plans live in [`docs/superpowers/`](docs/superpowers/). Architecture notes in [`CLAUDE.md`](CLAUDE.md).

## What is genuinely quantum vs. classical

**Quantum (via Qiskit):**
- Every wall collapse — non-zero superposition and Bell circuits are real `QuantumCircuit` objects, executed by `AerSimulator`, sampled via projective measurement.
- The probability distributions the maze samples from are the genuine quantum distributions.
- Bell-pair correlations violate the Bell inequality — the CHSH panel *empirically demonstrates* this live on screen with `S ≈ 2.7`.

**Classical (and honestly so):**
- Which walls get paired as Bell partners (`Math.random` + structural rules during setup).
- The loop-prevention and cycle-prevention rules that filter measurement candidates *before* the quantum circuit runs (closing walls to already-visited or already-reachable cells to keep the maze a tree).
- Rendering, input, animations.

The simulator runs the quantum math on a CPU — it is not physical quantum hardware. The statistics it produces are mathematically equivalent to a quantum computer for these small circuits.

## File layout

```
quantum-maze-game/
├── server.py                          # Flask + Qiskit backend
├── index.html                         # DOM scaffold, CSS, canvas elements
├── quantum.js                         # Fetch wrappers (wState, bell, nonzero, chsh)
├── maze.js                            # Game state, generation, rendering, CHSH loop, viz
├── requirements.txt                   # Python deps
├── tests/                             # Backend unit tests + e2e invariants
│   ├── test_server.py
│   ├── test_quantum.py
│   ├── test_chsh.py
│   └── e2e_invariants.js
├── docs/superpowers/
│   ├── specs/                         # Design documents per version
│   └── plans/                         # Implementation plans
├── CLAUDE.md                          # Architecture guide for Claude Code
└── README.md
```

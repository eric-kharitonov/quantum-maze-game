# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Set up Python environment
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt

# Start the Qiskit backend (port 5000)
python server.py

# Serve the frontend (port 8765) — in a second terminal
python -m http.server 8765

# Open the game
# http://localhost:8765/index.html
```

Run the backend test suite:

```bash
.venv\Scripts\python -m unittest discover tests -v
```

End-to-end invariant suite (in browser DevTools, with the static server running):

```js
await fetch('/tests/e2e_invariants.js').then(r => r.text()).then(eval);
console.log(await runE2ESuite(20));
```

To run on real IBM quantum hardware instead of the simulator, replace the `AerSimulator()` line in `server.py` with `QiskitRuntimeService().backend(...)`.

## Versions

- **v0.1** (`git tag v0.1`) — initial Quantum Maze with W-state mechanic and post-generation classical repair.
- **v0.2** (`git tag v0.2`) — pre-pick exit row quantumly, exclude exit walls from W-state, add post-Bell `repairOrphans`.
- **v0.3** (`quantum-fidelity` branch, tag `v0.3`) — replace W-state with per-wall non-zero superposition entangled circuit; remove all classical override; orphan-induced seal-offs end the game honestly.
- **v0.4** (current `quantum-fidelity` HEAD) — adds two verification/visualization layers on top of v0.3: a live **CHSH self-test panel** (runs Bell-pair measurements at varied angles in the background, computes S, displays violation past the classical 2.0 bound), **Bell partner threads** drawn on the minimap (visible non-locality before collapse), and an **amplitude-bar overlay** showing P(open) for each candidate wall during a non-zero circuit measurement. The maze mechanic itself is unchanged from v0.3.
- **v0.4.1** (`state-prep-honesty` branch) — replaces the Hadamard-plus-rejection-sampling implementation of `build_nonzero` with a direct state preparation via `qc.initialize`. The prepared statevector has amplitude exactly 0 on `|00…0⟩`, so the all-SOLID outcome is forbidden by unitary evolution rather than discarded after the fact. `sample_nonzero` is now a single shot, no `while`-loop. Observable behaviour for the player is unchanged; the README's claim of "literally zero amplitude" is now literally true. Added five tests in `tests/test_quantum.py` (`TestBuildNonzeroStatePrep`) that assert the amplitude property at the statevector level.
- **v0.4.2** (`bell-in-the-maze` branch) — replaces the maze's fixed-angle Bell measurements with random per-observation angle picks from the canonical CHSH set (Alice ∈ {0°, 45°}, Bob ∈ {22.5°, −22.5°}). Each Bell measurement contributes to `chshTally`; a new `gameplayTrials` counter tracks the gameplay-driven fraction, with `gameplaySame`/`gameplayDiffs` counters providing unbiased per-game disagreement stats for the e2e invariant. Partners can now disagree — a new `bellMismatch` flash renders these as a split cyan/amber pulse. `build_bell` and `build_chsh` are unified into one builder; `/collapse type=bell` accepts optional `alice_angle_deg` and `bob_angle_deg` (default 0). The CHSH endpoint stays for back-compat with the existing background loop.

Specs in `docs/superpowers/specs/`, plan in `docs/superpowers/plans/`.

## Architecture (v0.3)

The project splits cleanly into two layers:

**Backend (`server.py`)** — `POST /collapse` accepts `type: "w_state"`, `"bell"`, `"nonzero"`, or `"chsh"`. The `bell` and `chsh` types share the same `build_bell(alice_rad, bob_rad)` builder: prepares `|Φ+⟩`, applies `RY(-2*alice_rad)` and `RY(-2*bob_rad)`, measures both qubits. With both angles 0 the outcome is always-match (the v0.4 behavior); with varied angles, correlation is `cos(2*(a-b))` — the quantum signature that violates Bell's inequality. The `nonzero` type is the v0.3/v0.4.1 mechanic — `build_nonzero(k)` prepares `|ψ⟩ = (1/√(2^k − 1)) Σ_{x ≠ 0} |x⟩` directly via `qc.initialize` on a target statevector with amplitude 0 on `|00…0⟩` and `1/√(2^k − 1)` everywhere else. `sample_nonzero(k)` runs the circuit once — no rejection loop, since the all-zero outcome is forbidden by the unitary. `/collapse type=bell` accepts optional `alice_angle_deg` and `bob_angle_deg` (default 0). Circuits are run with `shots=1` on `AerSimulator`. Qiskit bitstrings are big-endian (reversed before use).

**Frontend (`maze.js` + `quantum.js`)** — all game state is module-level globals: `walls` (a flat object keyed by wall ID), `cells` (a 2-D `GRID×GRID` array of `{visited}`), `player`, `flashes` (animation queue), `stats`, `exitRow` (pre-picked at start), `exitOpenedRow`, `gameOver`.

**Wall ID encoding** — walls are identified as strings `H:r:c` (horizontal, between rows r and r+1) or `V:r:c` (vertical, between cols c and c+1). Border indices run from −1. `cellWalls(r,c)` returns the four wall IDs for a cell; `wallBetween` finds the wall separating two adjacent cells.

**Wall states** — four values: `SUPERPOSED` (default interior), `ENTANGLED` (pre-assigned Bell pair, visually identical to SUPERPOSED), `SOLID`, `OPEN`. The minimap only shows `SOLID`/`OPEN` walls. **In v0.3, no state ever reverses** — once a wall is SOLID or OPEN, it stays.

**Game start (`start()`)** — `resetState` → `initWalls` → quantum measurement to pick `exitRow` uniformly over rows 0–14 (via `Quantum.wState` with 15 dummy candidates) → `assignBellPairs` (must run after exit-row pick because the pair rules exclude walls adjacent to the exit cell) → `enterCell(0, 0)`.

**Maze generation (v0.3)** — when the player enters a new cell, `enterCell` runs a linear pipeline:
1. `processBell` measures any `ENTANGLED` walls adjacent to the cell, collapsing the local wall and its remote partner via the Bell circuit. (Bell can produce OPEN outcomes that bypass the cycle-prevention rule — these are "Bell wormholes," accepted per the spec.)
2. `applyLoopAndCyclePrevention(cell)` SOLID-closes walls to already-visited cells (loop prevention) and to unvisited-but-already-reachable cells (cycle prevention). Returns the surviving `SUPERPOSED` candidate sides.
3. `processNonzeroCircuit(cell, candidates)` fires a single quantum measurement over all candidates using `Quantum.nonzero` — at least one wall is guaranteed OPEN.
4. If this is the pre-picked exit cell, open the exit wall deterministically.
5. `checkExitSealed` BFS-es from the player's current position through non-SOLID walls. If the exit cell is no longer reachable, set `gameOver = true` and the game ends honestly — no classical override.

**Bell pair assignment (v0.3)** — `assignBellPairs` follows five structural rules to minimize the orphan rate:
- R1: at most one Bell-paired wall per cell
- R2: walls adjacent to (0,0) or the pre-picked exit cell are excluded
- R3: Manhattan distance between paired walls ≥ 5
- R4: only non-border, non-exit interior walls eligible
- R5: ~10% pair density target

Empirically ~10% of games end in seal-off; the rest reach the exit.

**No auto-backtrack in v0.3** — the DFS stack, `tryBacktrack`, `repairOrphans`, `repairConnectivity`, `markCellDone`, and `endGeneration` are all gone. The player walks back manually.

**Minimap click-to-teleport (v0.3)** — clicking any visited cell on the minimap jumps the player there. Pure UX convenience; no measurements fire. Compensates for the removal of auto-backtrack.

**Rendering** — `drawMain` draws the first-person 3D view using a painter's algorithm with nested perspective frames (constant `VIEW_SHRINK = 0.62`). `drawMini` draws the top-down minimap. Both canvases share the same `pulsePhase` clock for the amber glow on superposed walls. The `frame` loop advances `pulsePhase` and expires timed flash effects before each `render` call.

**`quantum.js`** — thin fetch wrapper that exposes `window.Quantum = { wState, bell, nonzero, chsh }`. The server URL is hardcoded to `http://localhost:5000`. Script tags in `index.html` include `?v=0.4` to invalidate browser HTTP cache when shipping new versions.

## v0.4 additions

**CHSH self-test (`chshLoop`, `computeChshS`, `drawChshPanel`)** — runs continuously in the background. Each ~2 seconds, picks random inputs `x, y ∈ {0, 1}`, sends a Bell-pair measurement at canonical CHSH angles (Alice: 0° or 45°; Bob: 22.5° or -22.5°) to `/collapse type=chsh`, tallies same/diff per `(x, y)`. The S value `E(0,0) + E(0,1) + E(1,0) − E(1,1)` is computed live and rendered into the `#chsh-panel` div. Classical bound is `S ≤ 2`; quantum reaches `S ≈ 2.828`. The loop self-cancels when `chshSessionId` changes (game restart).

**Bell partner threads (`drawBellThreads`)** — for every currently-ENTANGLED wall, draw a translucent purple dashed line to its partner's center on the minimap. Disappears the moment the pair collapses. Makes the non-local correlation visible *before* it fires.

**Amplitude bars (`amplitudeBars` array, `drawAmplitudeOverlay`)** — at the start of `processNonzeroCircuit`, push a bar entry per candidate with `marginal = 2^(k-1)/(2^k − 1)`. While in flight, render an overlay panel near the top of the main view showing each candidate's `P(open)`. On collapse, each bar resolves to 100%/0% with color (cyan/grey), then fades over 400ms.

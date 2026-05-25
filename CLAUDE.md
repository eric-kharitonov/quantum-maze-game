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
- **v0.3** (current `quantum-fidelity` branch) — replace W-state with per-wall non-zero superposition entangled circuit; remove all classical override; orphan-induced seal-offs end the game honestly. Specs in `docs/superpowers/specs/`, plan in `docs/superpowers/plans/`.

## Architecture (v0.3)

The project splits cleanly into two layers:

**Backend (`server.py`)** — a single Flask route `POST /collapse` that accepts a JSON body with `type: "w_state"`, `type: "bell"`, or `type: "nonzero"`. It builds the corresponding Qiskit `QuantumCircuit`, runs it with `shots=1` on `AerSimulator`, and returns the measurement outcome. The `nonzero` type is the v0.3 mechanic — `build_nonzero(k)` puts k qubits in equal Hadamard superposition, and `sample_nonzero(k)` rejection-samples until a non-zero bit-string appears, materializing the state `|ψ⟩ = (1/√(2^k − 1)) Σ_{x ≠ 0} |x⟩`. The Bell circuit is a standard Φ⁺ state. Qiskit bitstrings are big-endian (reversed before use).

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

**`quantum.js`** — thin fetch wrapper that exposes `window.Quantum = { wState, bell, nonzero }`. The server URL is hardcoded to `http://localhost:5000`. Script tags in `index.html` include `?v=0.3` to invalidate browser HTTP cache when shipping new versions.

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

There are no build steps, no bundler, no linter config, and no test suite.

To run on real IBM quantum hardware instead of the simulator, replace the `AerSimulator()` line in `server.py` with `QiskitRuntimeService().backend(...)`.

## Architecture

The project splits cleanly into two layers:

**Backend (`server.py`)** — a single Flask route `POST /collapse` that accepts a JSON body with `type: "w_state"` or `type: "bell"`. It builds the corresponding Qiskit `QuantumCircuit`, runs it with `shots=1` on `AerSimulator`, and returns the measurement outcome. The W-state circuit uses CRY + CX gates to produce a k-qubit equal superposition of single-excitation states; the Bell circuit is a standard Φ⁺ state. Qiskit bitstrings are big-endian (reversed before use).

**Frontend (`maze.js` + `quantum.js`)** — all game state is module-level globals: `walls` (a flat object keyed by wall ID), `cells` (a 2-D `GRID×GRID` array of `{visited}`), `player`, `stack` (DFS backtrack stack), `flashes` (animation queue), and `stats`.

**Wall ID encoding** — walls are identified as strings `H:r:c` (horizontal, between rows r and r+1) or `V:r:c` (vertical, between cols c and c+1). Border indices run from −1. `cellWalls(r,c)` returns the four wall IDs for a cell; `wallBetween` finds the wall separating two adjacent cells.

**Wall states** — four values: `SUPERPOSED` (default interior), `ENTANGLED` (pre-assigned Bell pair, visually identical to SUPERPOSED), `SOLID`, `OPEN`. The minimap only shows `SOLID`/`OPEN` walls.

**Maze generation** — an async DFS seeded at cell (0,0). `enterCell` is the core routine: it closes superposed walls to already-visited neighbors (loop prevention), fires `processBell` for any entangled walls adjacent to the new cell, then fires `processWState` to pick the next open direction via the backend. When no progress is possible, `tryBacktrack` rewinds the DFS stack, teleporting the player visually. `assignBellPairs` runs once at game start, pairing ~10% of interior walls (targeting spatial distance ≥ 5) as Bell partners.

**Post-generation repair** — after DFS completes, `repairConnectivity` runs a Dijkstra pass that force-opens the minimum number of SOLID walls needed to connect start (0,0) to the exit row. Repaired walls flash white to distinguish them from quantum collapses.

**Rendering** — `drawMain` draws the first-person 3D view using a painter's algorithm with nested perspective frames (constant `VIEW_SHRINK = 0.62`). `drawMini` draws the top-down minimap. Both canvases share the same `pulsePhase` clock for the amber glow on superposed walls. The `frame` loop advances `pulsePhase` and expires timed flash effects before each `render` call.

**`quantum.js`** — thin fetch wrapper that exposes `window.Quantum = { wState, bell }`. The server URL is hardcoded to `http://localhost:5000`.

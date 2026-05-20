# Quantum Maze

A browser-based maze game where the maze doesn't exist until you observe it. Every wall is a qubit in superposition. Your movement collapses quantum states one measurement at a time, using real quantum circuits running on Qiskit's `AerSimulator`.

Two quantum mechanics drive the gameplay:

- **W-state superposition** — at each new cell, a `k`-qubit W-state circuit picks which wall opens. Every other valid direction stays in superposition until measured from elsewhere.
- **Bell-state entanglement** — about 20% of walls are paired at game start. When you observe one, its distant partner collapses simultaneously to the same outcome. The correlations violate the Bell inequality.

## Stack

- **Frontend** — vanilla HTML/JS, no frameworks. First-person 3D maze view + top-down minimap on a single page.
- **Backend** — Flask + Qiskit. One HTTP endpoint that builds and measures quantum circuits.
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

| Key | Action |
|-----|--------|
| ↑ | Move forward |
| ↓ | Move backward |
| ← | Turn left 90° |
| → | Turn right 90° |
| Restart button | New maze (fresh Bell-pair assignment) |

Reach the right edge of the grid. When the W-state opens the right-border wall on your row, walk through to escape.

## Game design

A separate **Product Design Document** describes the full design, the W-state algorithm, Bell-state mechanics, and the resolved design decisions. The two interpretation calls made during implementation:

1. **Unchosen W-state candidate walls stay in superposition.** They are not closed to SOLID at first observation. This is what allows branching to emerge from DFS backtracking — the W-state can fire again at the same cell when the algorithm returns there.
2. **Bell wormholes are allowed.** Bell measurements that decide OPEN can connect already-visited cells, creating non-local shortcuts. This preserves the quantum measurement (Bell results are never overridden) at the cost of the maze not being a strict tree.

When quantum measurements happen to disconnect the start cell from the exit, a **classical post-collapse repair** runs at end-of-generation: Dijkstra finds the shortest sequence of SOLID walls to force OPEN, ensuring the maze is always winnable. The repaired walls flash white briefly to distinguish them from quantum-collapsed walls.

## File layout

```
quantum-maze/
├── server.py         # Flask + Qiskit backend (POST /collapse)
├── index.html        # DOM scaffold, CSS, canvas elements
├── quantum.js        # Fetch wrappers for the /collapse endpoint
├── maze.js           # Game state, generation algorithm, first-person rendering
├── requirements.txt  # Python deps
└── README.md
```

## What is genuinely quantum vs. classical

**Quantum (via Qiskit):**
- Every wall collapse — W-state and Bell circuits are real `QuantumCircuit` objects, executed by `AerSimulator`, sampled via projective measurement.
- The probability distributions the maze samples from are the genuine quantum distributions.
- Bell-pair correlations violate the Bell inequality.

**Classical:**
- Which walls get paired as Bell partners (`Math.random` during setup).
- The Dijkstra post-collapse repair when quantum disconnects start from exit.
- Loop closure when both incident cells of a wall become visited.
- Rendering, input, animations.

The simulator runs the quantum math on a CPU — it is not physical quantum hardware. The statistics it produces are mathematically equivalent to a quantum computer for these small circuits.

# Quantum Maze: building a browser game where the maze isn't real until you look at it

Most quantum computing demos either ask you to read a paper or stare at a histogram. I wanted something you could drive around in. So I built Quantum Maze — a top-down maze where the walls don't actually exist until your character observes them, and where some walls are quantum-entangled with walls on the other side of the board.

What makes it more than a gimmick is that the game's physics is wired directly into Qiskit. Every wall that "collapses" is a real measurement on a real circuit running on the AerSimulator. Every Bell-pair flash is a |Φ+⟩ state being measured at two different angles. And while you walk around, the game accumulates a running CHSH score in a side panel — the same statistical signature that the 2022 Nobel Prize was awarded for.

This article walks through three things in that order: what the game looks like to play, the math that drives each mechanic, and the code that ties the math to the screen. The project itself is open source and the version I'll be referencing is v0.4.2.

## What you actually see on screen

The maze is rendered as a grid of cells. Walls between cells can be in one of three states:

- **Solid** — a normal wall. You can't walk through it.
- **Open** — there's a passage. You can walk through it.
- **Uncollapsed** — a glowing amber wall. It hasn't been measured yet. It is neither open nor solid until you look at it.

The "looking at it" is literal. The game only measures the walls adjacent to your current cell, the moment you arrive in that cell. Until then, those walls live in superposition.

There's one more wrinkle. A small fraction of the uncollapsed walls are secretly paired with walls somewhere else in the maze — entangled partners. When you observe one of them, the other one collapses at the same instant, sometimes flashing purple on the minimap on the other side of the board. Spooky action at a distance, on a grid.

The win condition is simple: reach the right edge.

## Rule 1: a set of walls cannot all be solid

The first piece of quantum mechanics in the game is the rule that, when you arrive at a cell, at least one of its uncollapsed neighbors has to open up. Otherwise the game would be unwinnable from the inside of a sealed pocket.

Naive approach: flip a fair coin for each wall, and if they all land "solid," re-roll. That's classical post-selection, and it would work, but it's not honest about being quantum. The state being prepared is the all-zero state with a classical reject-list on top.

The honest approach is to prepare a quantum state where the all-solid outcome has amplitude exactly zero. Then measurement, which is the only randomness available, simply cannot produce it.

Here's the state. For `k` walls being observed, you want:

```
|ψ⟩ = (1 / √(2^k − 1)) · Σ_{x ≠ 0} |x⟩
```

That's a uniform superposition over every basis state *except* `|00…0⟩`. The amplitude on the all-zero outcome is zero by construction, so the Born rule guarantees you never measure it. There's no post-selection. There's no classical retry. Unitary evolution refuses to put you there.

Qiskit makes preparing this state one line. Given a target statevector, `qc.initialize` synthesizes the unitary that takes `|00…0⟩` to that target.

```python
def build_nonzero(k):
    if k < 1:
        raise ValueError(f"build_nonzero requires k >= 1, got {k}")
    amplitude = 1.0 / np.sqrt(2**k - 1)
    target = np.zeros(2**k, dtype=complex)
    target[1:] = amplitude  # index 0 = |00..0> stays at 0
    qc = QuantumCircuit(k, k)
    qc.initialize(target, range(k))
    qc.measure(range(k), range(k))
    return qc
```

A few things worth unpacking. The `target` vector has `2^k` entries; index zero is the amplitude of `|00…0⟩`, and we leave it as zero. Every other index gets the same amplitude, normalized so the probabilities sum to one. The call to `initialize` is doing real work — it's compiling that target into a sequence of gates that produce it from the all-zero start state.

When this circuit is measured, the outcome bitstring tells you which walls open and which close. A `1` on qubit `i` means wall `i` opens. A `0` means it stays solid. The bitstring `00…0` simply does not exist in the output distribution.

I have unit tests that prepare this state and check the statevector directly — the amplitude on `|00…0⟩` is zero to ten decimal places, which is as close to "exactly zero" as floating point gets.

## Rule 2: some walls are entangled

The second piece is more dramatic. A small number of uncollapsed walls have a hidden partner elsewhere in the maze. When you observe one, you also observe the partner. The way that joint measurement turns out is where things stop looking classical.

The partner pair is prepared in the Bell state:

```
|Φ+⟩ = (|00⟩ + |11⟩) / √2
```

If you measure both qubits in the standard Z basis, you get either `00` or `11`, each with probability one-half. They always agree. That's interesting, but a sealed envelope with a "shared coin flip" gives you the same statistics. There's no observable difference between |Φ+⟩ measured in Z and a classical correlated pair.

The escape hatch — the thing that makes the maze actually quantum and not just thematically quantum — is that you can measure each end at a different angle. Once you do that, the correlation becomes:

```
E(a, b) = cos(2(a − b))
```

where `a` is the angle Alice (the local wall) measures along and `b` is the angle Bob (the partner wall) measures along. When the angles match, `cos(0) = 1` — perfect agreement, the boring case. When they're 45° apart, `cos(π/2) = 0` — fully uncorrelated. At 90° apart, `cos(π) = −1` — perfect anti-correlation. No classical hidden-variable model can reproduce this whole curve.

In Qiskit, rotating the measurement axis by an angle θ is equivalent to applying `RY(−2θ)` before a Z-basis measurement (the factor of 2 comes from the fact that `RY(θ)` rotates the Bloch sphere by `θ/2`, not `θ`). So the Bell-pair circuit looks like this:

```python
def build_bell(alice_rad=0.0, bob_rad=0.0):
    qc = QuantumCircuit(2, 2)
    qc.h(0)
    qc.cx(0, 1)
    if alice_rad != 0.0:
        qc.ry(-2 * alice_rad, 0)
    if bob_rad != 0.0:
        qc.ry(-2 * bob_rad, 1)
    qc.measure([0, 1], [0, 1])
    return qc
```

The first two gates prepare |Φ+⟩ — a Hadamard on qubit 0 puts it in superposition, then a CNOT entangles qubit 1 with it. The two conditional `RY` gates rotate each measurement axis independently. If both angles are zero, you get the classical-looking same-basis Bell measurement (and the game behavior reduces to "partners always match," which is what the earlier version of the game did). When the angles differ, partners can disagree, and they do so with frequencies that no local theory can reproduce.

In the game, when you observe a Bell wall, the server picks a random angle pair from a canonical set — Alice from {0°, 45°} and Bob from {22.5°, −22.5°}. Each end gets its own bit. A `1` opens the wall on that side; a `0` keeps it solid. Sometimes both walls open. Sometimes both stay solid. Sometimes one opens and the other doesn't — and on the minimap, that mismatch shows up as a flash split into cyan and amber halves. The disagreement is visible.

## Rule 3: the CHSH score is a live non-locality proof

Now the payoff. The four angles I just listed are not arbitrary. They are the canonical CHSH angles, and the reason they were chosen is that with the |Φ+⟩ correlation `cos(2(a − b))`, they produce the maximum possible quantum violation of the CHSH inequality.

The CHSH quantity is:

```
S = E(a, b) − E(a, b′) + E(a′, b) + E(a′, b′)
```

where `a, a′` are Alice's two possible angles and `b, b′` are Bob's two. Any local hidden-variable theory — any model where each particle "decides" its outcome based on shared classical information set up at preparation time — is constrained to `|S| ≤ 2`. This is Bell's theorem. It's not a quantum theorem. It's a constraint on classical models.

Quantum mechanics predicts `|S| ≤ 2√2 ≈ 2.828` (Tsirelson's bound). For the angles 0°, 45°, 22.5°, −22.5° on |Φ+⟩, the predicted value is exactly 2√2. Real experiments — the ones the 2022 Nobel was awarded for — measure values around 2.7 once detector loopholes are closed.

In the game, every Bell observation contributes a data point. The frontend keeps a `chshTally` of how often each angle pair produced agreement or disagreement, computes the four correlations, and updates `S` live in a side panel.

```js
function computeS(tally) {
  const E = (x, y) => {
    const { same, diff } = tally.counts[x][y];
    const total = same + diff;
    if (total === 0) return 0;
    return (same - diff) / total;
  };
  return E(0, 0) - E(0, 1) + E(1, 0) + E(1, 1);
}
```

Each `E(x, y)` is the empirical correlation for one angle pair, computed as `(agreements − disagreements) / total`. The sign pattern in `S` — three plus, one minus — is what makes the inequality work. With classical correlations, the constraint `|S| ≤ 2` falls out of basic combinatorics; with the quantum correlations from `cos(2(a − b))`, you get up to `2√2`.

In practice, the side panel starts at `S = 0` and drifts toward `2√2` as you play. Once enough trials accumulate, it parks somewhere around 2.5 to 2.7 (the slight gap from the theoretical 2.828 is just statistical noise from finite trials). The bar turns cyan once it crosses 2.0. That cyan-bar moment is the live proof, on your screen, that what you just did with your arrow keys cannot be explained by any local-realistic theory.

## What this isn't

I'll be honest about what the project is and isn't.

It is a faithful demo of three things: state preparation via `initialize`, Bell-state measurement at varied bases, and a running CHSH tally driven by gameplay. The math is correct, the tests verify the empirical correlations against `cos(2(a − b))` within statistical bounds, and the unit tests on the prepared statevector check that the all-zero amplitude is exactly zero, not just rare.

It isn't a noise model. The AerSimulator I'm using is the ideal, noiseless simulator, so the CHSH score parks near 2√2 rather than at the noisy ~2.7 you'd see on real hardware. I haven't yet run the same Bell circuit on an IBM quantum backend to compare, though that's a small change.

It also isn't a persistent statevector. Each Bell observation is its own two-qubit circuit prepared from scratch. The maze's "entangled" walls are entangled in the sense that each observation prepares and measures a real entangled pair — but there is no single global statevector for the whole board across time. That's the next thing on my list to fix, alongside the win condition (which is currently picked at maze generation time, classically — really it should be a W-state measurement on the right column the first time you arrive there).

## Why I built it

A lot of quantum learning material asks you to take its word for the weirdness. You read that entangled particles violate Bell's inequality, and you nod, and you move on. The thing that hooked me on quantum computing — and the thing I wanted to put in a player's hands — is that the violation isn't an abstract theorem. It's a number, you can compute it from outcomes you can see, and once it's above 2 you have ruled out an entire class of physical theories.

The maze is a wrapper around that experience. The walls are an excuse for a measurement. The minimap flash is an excuse to make the partner correlation visible. The CHSH panel is the actual point — it's the part that, if you sit with it long enough, makes you stop and look up Bell's theorem on Wikipedia and realize what just happened on the screen.

The code is at [github.com/your-handle/quantum-maze-game] and runs in a browser against a small Flask backend. The whole thing is under 1500 lines.

---

Next on the list: noise model toggle, a real IBM hardware run for the Bell circuit, and an exit condition that's itself a W-state measurement rather than a classical pre-pick. I'll write those up if and when they land.

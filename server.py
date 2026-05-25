import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator

app = Flask(__name__)
CORS(app)

simulator = AerSimulator()


def build_w_state(k):
    """k-qubit W-state: equal superposition of all single-qubit-|1> states."""
    qc = QuantumCircuit(k, k)
    if k == 1:
        qc.x(0)
        qc.measure(0, 0)
        return qc
    qc.x(0)
    for i in range(k - 1):
        # Angle that splits remaining amplitude equally across k-i remaining qubits
        theta = 2 * np.arccos(np.sqrt(1 / (k - i)))
        qc.cry(theta, i, i + 1)
        qc.cx(i + 1, i)
    qc.measure(range(k), range(k))
    return qc


def build_nonzero(k):
    """Prepare the non-zero superposition state on k qubits:

        |psi> = (1/sqrt(2^k - 1)) * sum_{x != 0} |x>

    The all-zero basis state has amplitude exactly 0 — measurement can never
    produce 00...0. This is a property of the prepared state, not of any
    post-selection. Qiskit's `initialize` synthesizes the unitary that takes
    |00...0> to this target statevector.
    """
    if k < 1:
        raise ValueError(f"build_nonzero requires k >= 1, got {k}")
    amplitude = 1.0 / np.sqrt(2**k - 1)
    target = np.zeros(2**k, dtype=complex)
    target[1:] = amplitude  # index 0 = |00..0> stays at 0
    qc = QuantumCircuit(k, k)
    qc.initialize(target, range(k))
    qc.measure(range(k), range(k))
    return qc


def sample_nonzero(k):
    """Sample one outcome from the non-zero superposition state.

    A single shot suffices: by construction the prepared state has zero
    amplitude on |00..0>, so the all-zero outcome is unitarily forbidden —
    no rejection sampling required.

    Returns the bitstring (big-endian: position -(i+1) is qubit i).
    """
    qc = build_nonzero(k)
    return run_once(qc)


def build_bell():
    """Standard Bell state |Φ+⟩ = (|00⟩ + |11⟩)/√2."""
    qc = QuantumCircuit(2, 2)
    qc.h(0)
    qc.cx(0, 1)
    qc.measure([0, 1], [0, 1])
    return qc


def build_chsh(alice_angle_rad, bob_angle_rad):
    """Bell pair measured along requested axes. Used for the CHSH inequality
    test: with alice_angle in {0, pi/4} and bob_angle in {pi/8, -pi/8},
    repeated trials produce S = 2*sqrt(2) ~ 2.828, violating the classical
    bound |S| <= 2.

    The factor of 2 in RY(-2*angle) comes from the half-angle representation
    of Bloch sphere rotations: RY(theta) rotates the state vector by theta/2
    on the sphere, so to rotate the measurement axis by `angle`, we apply
    RY(-2*angle) before the standard Z-basis measurement.
    """
    qc = QuantumCircuit(2, 2)
    # Prepare |Phi+>:
    qc.h(0)
    qc.cx(0, 1)
    # Rotate each qubit so the measurement axis aligns with the requested angle.
    qc.ry(-2 * alice_angle_rad, 0)
    qc.ry(-2 * bob_angle_rad, 1)
    qc.measure([0, 1], [0, 1])
    return qc


def run_once(qc):
    job = simulator.run(qc, shots=1)
    result = job.result()
    counts = result.get_counts()
    return list(counts.keys())[0]


@app.route("/collapse", methods=["POST"])
def collapse():
    data = request.get_json(force=True)
    circuit_type = data.get("type")

    if circuit_type == "w_state":
        candidates = data.get("candidates", [])
        k = len(candidates)
        if k == 0:
            return jsonify({"error": "no candidates provided"}), 400
        qc = build_w_state(k)
        bitstring = run_once(qc)
        # Qiskit bitstring is big-endian: rightmost character = q[0]
        # Reverse so index i corresponds to qubit i
        chosen = bitstring[::-1].index("1")
        return jsonify({"chosen": chosen})

    elif circuit_type == "bell":
        qc = build_bell()
        bitstring = run_once(qc)
        # bitstring is "q1q0" → bitstring[1]=q0, bitstring[0]=q1
        a = int(bitstring[1])
        b = int(bitstring[0])
        return jsonify({"a": a, "b": b})

    elif circuit_type == "chsh":
        try:
            alice_deg = float(data.get("alice_angle_deg", 0.0))
            bob_deg = float(data.get("bob_angle_deg", 0.0))
        except (TypeError, ValueError):
            return jsonify({"error": "alice_angle_deg/bob_angle_deg must be numbers"}), 400
        alice_rad = np.deg2rad(alice_deg)
        bob_rad = np.deg2rad(bob_deg)
        qc = build_chsh(alice_rad, bob_rad)
        bitstring = run_once(qc)
        # bitstring is "q1q0" -> bitstring[1] = q0 = Alice's outcome.
        a = int(bitstring[1])
        b = int(bitstring[0])
        return jsonify({"a": a, "b": b})

    elif circuit_type == "nonzero":
        candidates = data.get("candidates", [])
        k = len(candidates)
        if k == 0:
            return jsonify({"error": "no candidates provided"}), 400
        bitstring = sample_nonzero(k)
        # bitstring is big-endian: position -(i+1) corresponds to qubit i.
        outcomes = [int(bitstring[-(i + 1)]) for i in range(k)]
        return jsonify({"outcomes": outcomes})

    else:
        return jsonify({"error": f"unknown type: {circuit_type!r}"}), 400


if __name__ == "__main__":
    app.run(port=5000, debug=True)

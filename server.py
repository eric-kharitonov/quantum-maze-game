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
    """Hadamard layer on k qubits: uniform superposition over all 2^k strings.

    To produce the non-zero superposition state |ψ> = (1/sqrt(2^k - 1)) *
    sum_{x != 0} |x>, sample this circuit and reject the all-zero outcome.
    Use sample_nonzero(k) for the post-selected outcome directly.
    """
    qc = QuantumCircuit(k, k)
    for i in range(k):
        qc.h(i)
    qc.measure(range(k), range(k))
    return qc


def sample_nonzero(k, max_retries=64):
    """Sample one outcome from the non-zero superposition state.

    Runs build_nonzero(k) repeatedly, discarding all-zero outcomes. With k
    qubits, P(all-zero) = 1/2^k so expected retries is 2^k/(2^k - 1) <= 2.

    Returns the bitstring (big-endian: position -(i+1) is qubit i).
    Raises RuntimeError if max_retries exhausted (should never happen
    statistically for k >= 1).
    """
    qc = build_nonzero(k)
    for _ in range(max_retries):
        bitstring = run_once(qc)
        if "1" in bitstring:
            return bitstring
    raise RuntimeError(f"rejection sampling exhausted for k={k}")


def build_bell():
    """Standard Bell state |Φ+⟩ = (|00⟩ + |11⟩)/√2."""
    qc = QuantumCircuit(2, 2)
    qc.h(0)
    qc.cx(0, 1)
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

    else:
        return jsonify({"error": f"unknown type: {circuit_type!r}"}), 400


if __name__ == "__main__":
    app.run(port=5000, debug=True)

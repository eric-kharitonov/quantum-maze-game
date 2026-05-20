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

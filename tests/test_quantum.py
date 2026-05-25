import unittest
from collections import Counter

from qiskit.quantum_info import Statevector

import server


class TestBuildNonzeroStatePrep(unittest.TestCase):
    """Verify build_nonzero prepares the actual non-zero superposition state.

    The all-zero basis state has amplitude exactly 0 — a property of the
    prepared quantum state, not of any classical post-selection.
    """

    def _statevector(self, k):
        qc = server.build_nonzero(k)
        qc.remove_final_measurements()
        return Statevector.from_instruction(qc)

    def test_all_zero_amplitude_is_zero_k1(self):
        sv = self._statevector(1)
        self.assertAlmostEqual(abs(sv.data[0]), 0.0, places=10)

    def test_all_zero_amplitude_is_zero_k2(self):
        sv = self._statevector(2)
        self.assertAlmostEqual(abs(sv.data[0]), 0.0, places=10)

    def test_all_zero_amplitude_is_zero_k3(self):
        sv = self._statevector(3)
        self.assertAlmostEqual(abs(sv.data[0]), 0.0, places=10)

    def test_nonzero_amplitudes_uniform_k3(self):
        # All 7 non-zero basis states should have equal |amp|^2 = 1/7
        sv = self._statevector(3)
        for i in range(1, 2**3):
            self.assertAlmostEqual(abs(sv.data[i]) ** 2, 1 / 7, places=10)

    def test_rejects_k_below_one(self):
        with self.assertRaises(ValueError):
            server.build_nonzero(0)


class TestSampleNonzero(unittest.TestCase):
    """Verify sample_nonzero(k) produces the non-zero superposition state."""

    def _samples(self, k, n):
        return Counter(server.sample_nonzero(k) for _ in range(n))

    def test_k1_always_one(self):
        # Only one nonzero outcome exists for k=1: "1"
        counts = self._samples(1, n=200)
        self.assertEqual(set(counts.keys()), {"1"})

    def test_k2_no_all_zero(self):
        # |00> is forbidden; 3 outcomes possible
        counts = self._samples(2, n=600)
        self.assertNotIn("00", counts)
        self.assertLessEqual(len(counts), 3)
        # Each of the 3 valid outcomes should appear; rough uniformity check
        for outcome in ("01", "10", "11"):
            self.assertGreater(counts.get(outcome, 0), 600 / 3 * 0.6)

    def test_k3_no_all_zero(self):
        counts = self._samples(3, n=800)
        self.assertNotIn("000", counts)
        self.assertLessEqual(len(counts), 7)

    def test_k4_marginal_open_probability(self):
        # For k=4 the marginal P(bit i = 1) = 8/15 ~ 0.533
        n = 1500
        counts = self._samples(4, n=n)
        self.assertNotIn("0000", counts)
        # bitstrings are big-endian; bit i (the qubit) is at position -(i+1)
        per_qubit_ones = [0, 0, 0, 0]
        for bitstr, ncount in counts.items():
            for i in range(4):
                if bitstr[-(i + 1)] == "1":
                    per_qubit_ones[i] += ncount
        for ones in per_qubit_ones:
            # within ~6% absolute of expected 8/15
            self.assertAlmostEqual(ones / n, 8 / 15, delta=0.06)


if __name__ == "__main__":
    unittest.main()

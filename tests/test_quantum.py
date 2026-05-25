import unittest
from collections import Counter

import server


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

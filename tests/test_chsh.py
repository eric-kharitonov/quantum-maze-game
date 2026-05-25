"""CHSH inequality test: a Bell pair measured at the standard CHSH angles
should violate the classical bound |S| <= 2 and reach S = 2*sqrt(2) ~= 2.828.

We sample many trials at each of the four (x, y) angle pairs, compute the
correlation E(x, y) = P(a == b | x, y) - P(a != b | x, y), then combine into:

    S = E(0, 0) + E(0, 1) + E(1, 0) - E(1, 1)

Quantum mechanics gives S = 2*sqrt(2). With finite samples the empirical
value scatters around that; we test that it lands well above 2.
"""
import math
import unittest

import numpy as np

import server


# Standard CHSH angles (in degrees) for maximal violation with |Phi+>.
ALICE_ANGLES = [0.0, 45.0]   # for x = 0, 1
BOB_ANGLES = [22.5, -22.5]   # for y = 0, 1


def _correlation(x_idx, y_idx, shots):
    """E(x, y) over `shots` trials."""
    qc = server.build_chsh(
        np.deg2rad(ALICE_ANGLES[x_idx]),
        np.deg2rad(BOB_ANGLES[y_idx]),
    )
    job = server.simulator.run(qc, shots=shots)
    counts = job.result().get_counts()
    # Each bitstring is "q1q0"; q0 is Alice's outcome.
    same = 0
    diff = 0
    for bitstr, n in counts.items():
        a = int(bitstr[1])
        b = int(bitstr[0])
        if a == b:
            same += n
        else:
            diff += n
    return (same - diff) / shots


class TestCHSHViolation(unittest.TestCase):
    def test_s_value_above_classical_bound(self):
        shots = 2000
        e00 = _correlation(0, 0, shots)
        e01 = _correlation(0, 1, shots)
        e10 = _correlation(1, 0, shots)
        e11 = _correlation(1, 1, shots)
        s = e00 + e01 + e10 - e11
        # Quantum prediction is 2 * sqrt(2) ~= 2.828. Allow 5% slack for
        # finite-shot noise (sigma ~= 1/sqrt(shots) per correlation, four
        # correlations, so the s combined sigma is ~2/sqrt(shots) ~= 0.045
        # at shots=2000).
        self.assertGreater(s, 2.5, f"S={s:.3f} should violate classical bound 2.0 strongly")
        self.assertLess(s, 2.9, f"S={s:.3f} should not exceed Tsirelson bound 2.828")

    def test_endpoint_returns_outcomes(self):
        # Lightweight smoke: hit the endpoint and confirm shape.
        import json
        server.app.testing = True
        client = server.app.test_client()
        r = client.post(
            "/collapse",
            data=json.dumps({
                "type": "chsh",
                "alice_angle_deg": 0.0,
                "bob_angle_deg": 22.5,
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        body = json.loads(r.data)
        self.assertIn("a", body)
        self.assertIn("b", body)
        self.assertIn(body["a"], (0, 1))
        self.assertIn(body["b"], (0, 1))


if __name__ == "__main__":
    unittest.main()

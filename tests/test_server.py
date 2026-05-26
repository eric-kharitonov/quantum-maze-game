import json
import unittest

import server


class TestCollapseEndpoint(unittest.TestCase):
    def setUp(self):
        server.app.testing = True
        self.client = server.app.test_client()

    def _post(self, payload):
        r = self.client.post(
            "/collapse",
            data=json.dumps(payload),
            content_type="application/json",
        )
        return r.status_code, json.loads(r.data)

    def test_imports_clean(self):
        # Sanity: server module loads.
        self.assertTrue(hasattr(server, "app"))

    def test_nonzero_returns_outcomes_length_k(self):
        for k in (1, 2, 3, 4):
            status, body = self._post({
                "type": "nonzero",
                "cell": [0, 0],
                "candidates": [[0, 0]] * k,
            })
            self.assertEqual(status, 200, body)
            self.assertIn("outcomes", body)
            self.assertEqual(len(body["outcomes"]), k)
            for v in body["outcomes"]:
                self.assertIn(v, (0, 1))

    def test_nonzero_never_all_zero(self):
        # Run 60 trials at k=4; not a single all-zero result should appear.
        for _ in range(60):
            _, body = self._post({
                "type": "nonzero",
                "cell": [0, 0],
                "candidates": [[0, 0]] * 4,
            })
            self.assertTrue(
                any(body["outcomes"]),
                f"got all-zero outcome: {body['outcomes']}",
            )

    def test_nonzero_rejects_k_zero(self):
        status, body = self._post({
            "type": "nonzero",
            "cell": [0, 0],
            "candidates": [],
        })
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_bell_default_angles_perfectly_correlated(self):
        # With no angle params, both ends measure in Z -> always match.
        same = 0
        for _ in range(40):
            _, body = self._post({"type": "bell"})
            if body["a"] == body["b"]:
                same += 1
        self.assertEqual(same, 40)

    def test_bell_with_angles_can_disagree(self):
        # At 45 degrees difference, E = cos(pi/2) = 0; expect ~50% disagreement.
        disagree = 0
        for _ in range(200):
            _, body = self._post({
                "type": "bell",
                "alice_angle_deg": 0.0,
                "bob_angle_deg": 45.0,
            })
            if body["a"] != body["b"]:
                disagree += 1
        # Allow generous bounds (binomial noise)
        self.assertGreater(disagree, 60)
        self.assertLess(disagree, 140)


if __name__ == "__main__":
    unittest.main()

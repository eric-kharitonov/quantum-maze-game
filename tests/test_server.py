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


if __name__ == "__main__":
    unittest.main()

import unittest


class TestServerImport(unittest.TestCase):
    def test_imports_clean(self):
        # If this fails, server.py has a syntax or import error.
        import server  # noqa: F401


if __name__ == "__main__":
    unittest.main()

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


LIBRARY = Path(__file__).resolve().parents[1] / "scripts" / "python_runtime.sh"


class PythonRuntimeSelectionTests(unittest.TestCase):
    def run_selector(self, folder, override=None):
        env = {**os.environ, "PATH": str(folder), "RI_RUNTIME_ROOT": str(folder / "runtime")}
        env.pop("RI_PYTHON_BIN", None)
        if override is not None:
            env["RI_PYTHON_BIN"] = override
        return subprocess.run(["/bin/bash", "-c", 'source "$1"; ri_resolve_python', "runtime-test", str(LIBRARY)],
                              env=env, capture_output=True, text=True)

    def test_older_default_does_not_hide_compatible_versioned_python(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            old = folder / "python3"
            old.write_text("#!/bin/sh\nexit 1\n")
            old.chmod(0o755)
            (folder / "python3.12").symlink_to(sys.executable)
            result = self.run_selector(folder)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path(result.stdout.strip()).resolve(), Path(sys.executable).resolve())

    def test_explicit_invalid_choice_is_reported_without_silent_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / "python3.12").symlink_to(sys.executable)
            result = self.run_selector(folder, str(folder / "missing-python"))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("RI_PYTHON_BIN", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_app_runtime_works_without_path_python(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            binary = folder / "runtime" / "bin" / "python3.12"
            binary.parent.mkdir(parents=True)
            binary.symlink_to(sys.executable)
            result = self.run_selector(folder)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path(result.stdout.strip()).resolve(), Path(sys.executable).resolve())

    def test_missing_python_points_to_separate_runtime_preparation(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_selector(Path(temporary))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("setup_python.sh", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_private_base_directory_is_not_reported_accessible_to_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            private_base = folder / "private-base"
            private_base.mkdir(mode=0o700)
            # Root can start a private interpreter. Reproduce its reported base
            # without copying an entire Python distribution into this unit test.
            candidate = folder / "private-python"
            candidate.write_text(
                f"#!{sys.executable}\nimport sys\nsys.base_prefix = {str(private_base)!r}\nexec(sys.argv[-1])\n"
            )
            candidate.chmod(0o755)
            result = self.run_selector(folder, str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()

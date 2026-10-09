import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "download_model.py"
spec = importlib.util.spec_from_file_location("download_model", SCRIPT)
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


class ModelInstallPermissionsTests(unittest.TestCase):
    def test_existing_verified_model_becomes_readable_to_dedicated_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "model"
            destination.mkdir(mode=0o700)
            for name in (*downloader.MODEL_FILES, "model-manifest.json"):
                path = destination / name
                path.write_bytes(b"public pinned model data")
                path.chmod(0o600)
            with patch.object(downloader, "verify_model") as verify:
                downloader.download_model(destination)
            verify.assert_called_once_with(destination)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)
            for name in (*downloader.MODEL_FILES, "model-manifest.json"):
                self.assertEqual(stat.S_IMODE((destination / name).stat().st_mode), 0o644)


if __name__ == "__main__":
    unittest.main()

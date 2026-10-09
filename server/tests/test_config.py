import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ri_subtitles.config import Config


class PublicConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.environment = {
            "RI_SUBTITLES_DATA_DIR": str(base / "jobs"),
            "RI_SUBTITLES_MODEL_DIR": str(base / "model"),
            "RI_SUBTITLES_FONT_PATH": str(base / "font.ttf"),
            "RI_SUBTITLES_ALLOWED_ORIGINS": "https://djcioko.github.io",
        }

    def load_public_config(self, environment):
        with patch.dict(os.environ, environment, clear=True):
            try:
                return Config.from_env()
            except ValueError as error:
                self.fail(f"Valid public service settings rejected: {error}")

    def test_service_starts_from_env_without_access_code(self):
        config = self.load_public_config(self.environment)
        self.assertEqual(config.allowed_origins, ("https://djcioko.github.io",))
        self.assertEqual(config.data_dir, Path(self.environment["RI_SUBTITLES_DATA_DIR"]))
        self.assertEqual(config.max_input_bytes, 512 * 1024 * 1024)
        self.assertEqual(config.max_pending_jobs, 3)
        self.assertFalse(hasattr(config, "access_code"))

    def test_legacy_access_code_environment_is_ignored(self):
        config = self.load_public_config({**self.environment, "RI_SUBTITLES_ACCESS_CODE": "unused"})
        self.assertFalse(hasattr(config, "access_code"))
        self.assertEqual(config.allowed_origins, ("https://djcioko.github.io",))

    def test_operational_configuration_is_still_required(self):
        environment = dict(self.environment)
        environment.pop("RI_SUBTITLES_MODEL_DIR")
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ValueError, "MODEL_DIR"):
                Config.from_env()


if __name__ == "__main__":
    unittest.main()

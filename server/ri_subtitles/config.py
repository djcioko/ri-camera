import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    access_code: str
    data_dir: Path
    model_dir: Path
    font_path: Path
    allowed_origins: tuple[str, ...]
    max_input_bytes: int = 512 * 1024 * 1024
    max_duration: float = 900
    max_pending_jobs: int = 3
    max_spool_bytes: int = 4 * 1024 ** 3
    min_free_bytes: int = 2 * 1024 ** 3
    retention_seconds: float = 24 * 3600
    upload_ttl_seconds: float = 15 * 60
    job_timeout_seconds: float = 3600
    cpu_threads: int = 2
    max_pixels: int = 16777216

    def __post_init__(self):
        if len(self.access_code) < 32 or not self.access_code.isascii() or any(c.isspace() for c in self.access_code):
            raise ValueError("RI_SUBTITLES_ACCESS_CODE must contain at least 32 private ASCII characters")
        for field in ("data_dir", "model_dir", "font_path"):
            object.__setattr__(self, field, Path(getattr(self, field)).absolute())
        if not self.allowed_origins or any(not origin.startswith("https://") or origin.endswith("/") or "*" in origin for origin in self.allowed_origins):
            raise ValueError("Exact HTTPS allowed origins are required")
        for field in ("max_input_bytes", "max_duration", "max_pending_jobs", "max_spool_bytes", "retention_seconds", "upload_ttl_seconds", "job_timeout_seconds", "max_pixels"):
            if getattr(self, field) <= 0:
                raise ValueError(f"{field} must be positive")
        if self.min_free_bytes < 0 or not 1 <= self.cpu_threads <= 2:
            raise ValueError("Invalid reserve or CPU thread limit")

    @classmethod
    def from_env(cls):
        required = ("ACCESS_CODE", "DATA_DIR", "MODEL_DIR", "FONT_PATH", "ALLOWED_ORIGINS")
        missing = [name for name in required if not os.environ.get("RI_SUBTITLES_" + name)]
        if missing:
            raise ValueError("Missing subtitle service configuration: " + ", ".join(missing))
        values = {name.lower(): os.environ["RI_SUBTITLES_" + name] for name in required}
        values["allowed_origins"] = tuple(origin.strip() for origin in values["allowed_origins"].split(","))
        for field in cls.__dataclass_fields__.values():
            key = "RI_SUBTITLES_" + field.name.upper()
            if field.name not in values and key in os.environ:
                values[field.name] = float(os.environ[key]) if field.type is float else int(os.environ[key])
        return cls(**values)

    def limits(self):
        return {"maxInputBytes": self.max_input_bytes, "maxDuration": self.max_duration,
                "maxPendingJobs": self.max_pending_jobs, "maxSpoolBytes": self.max_spool_bytes,
                "minFreeBytes": self.min_free_bytes, "retentionSeconds": self.retention_seconds,
                "uploadTtlSeconds": self.upload_ttl_seconds, "jobTimeoutSeconds": self.job_timeout_seconds}

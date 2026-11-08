"""Worker settings from the environment (secrets never come from files in the image or from git)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "0.4.0"
ROOT = Path(__file__).resolve().parent.parent  # worker/
FONTS_DIR = ROOT / "fonts"


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw and raw.strip().isdigit() else default


@dataclass(frozen=True)
class Settings:
    bot_token: str
    worker_secret: str
    hub_url: str | None = None
    hub_key: str | None = None
    data_dir: Path = Path("/data")
    tmp_dir: Path = Path("/tmp/wanger")
    telegram_api: str = "https://api.telegram.org"
    light_workers: int = 2
    heavy_workers: int = 1
    max_input_mb: int = 20
    max_output_mb: int = 50
    max_image_pixels: int = 50_000_000
    max_side: int = 12000
    timeout_light_s: int = 30
    timeout_heavy_s: int = 120
    temp_retention_min: int = 30
    max_heavy_per_user: int = 1
    max_light_per_user: int = 2
    api_rate_per_min: int = 240
    memory_limit_mb: int = 2048  # address space of one processing child (prlimit)
    extra: dict = field(default_factory=dict)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "worker.sqlite"

    @property
    def jobs_dir(self) -> Path:
        return self.tmp_dir / "jobs"

    def limits(self) -> dict:
        return {
            "max_input_mb": self.max_input_mb,
            "max_output_mb": self.max_output_mb,
            "max_image_pixels": self.max_image_pixels,
            "max_side": self.max_side,
        }


def load() -> Settings:
    token = os.environ.get("BOT_TOKEN", "").strip()
    secret = os.environ.get("WORKER_SECRET", "").strip()
    if not token or not secret:
        raise SystemExit("BOT_TOKEN and WORKER_SECRET must be set (see .env.example)")
    if len(secret) < 32:
        raise SystemExit("WORKER_SECRET must be at least 32 characters")
    return Settings(
        bot_token=token,
        worker_secret=secret,
        hub_url=os.environ.get("HUB_URL") or None,
        hub_key=os.environ.get("HUB_KEY") or None,
        data_dir=Path(os.environ.get("DATA_DIR", "/data")),
        tmp_dir=Path(os.environ.get("TMP_DIR", "/tmp/wanger")),
        telegram_api=os.environ.get("TELEGRAM_API", "https://api.telegram.org").rstrip("/"),
        light_workers=_int("LIGHT_WORKERS", 2),
        heavy_workers=_int("HEAVY_WORKERS", 1),
        max_input_mb=_int("MAX_INPUT_MB", 20),
        max_output_mb=_int("MAX_OUTPUT_MB", 50),
        max_image_pixels=_int("MAX_IMAGE_PIXELS", 50_000_000),
        max_side=_int("MAX_SIDE", 12000),
        timeout_light_s=_int("JOB_TIMEOUT_LIGHT_S", 30),
        timeout_heavy_s=_int("JOB_TIMEOUT_HEAVY_S", 120),
        temp_retention_min=_int("TEMP_RETENTION_MIN", 30),
        memory_limit_mb=_int("MEMORY_LIMIT_MB", 2048),
    )

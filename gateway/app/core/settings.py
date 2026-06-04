from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel


class Settings(BaseModel):
    root_dir: Path
    data_dir: Path
    templates_dir: Path
    demo_session_id: str


def _path_from_env(name: str) -> Path | None:
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return None
    return Path(raw_value).expanduser()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    gateway_dir = Path(__file__).resolve().parents[2]
    root_dir = _path_from_env("FDE_INTERVIEW_ROOT_DIR") or gateway_dir.parent
    data_dir = _path_from_env("FDE_INTERVIEW_DATA_DIR") or root_dir / "data"
    templates_dir = _path_from_env("FDE_INTERVIEW_TEMPLATES_DIR") or root_dir / "templates"
    return Settings(
        root_dir=root_dir,
        data_dir=data_dir,
        templates_dir=templates_dir,
        demo_session_id=os.getenv("FDE_DEMO_SESSION_ID", "demo_session"),
    )

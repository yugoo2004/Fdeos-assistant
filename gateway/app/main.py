from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.settings import get_settings
from app.services.storage import ensure_storage


def _allowed_origins() -> list[str]:
    origins = {"http://127.0.0.1:5173", "http://localhost:5173"}
    configured = os.getenv("FDE_CORS_ORIGINS", "").strip()
    if configured:
        origins.update(origin.strip() for origin in configured.split(",") if origin.strip())
    return sorted(origins)


def create_app() -> FastAPI:
    settings = get_settings()
    ensure_storage(settings)

    app = FastAPI(title="FDE Interview Gateway", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router, prefix="/api")
    return app


app = create_app()

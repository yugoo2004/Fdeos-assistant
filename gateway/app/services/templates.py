from __future__ import annotations

from pathlib import Path

import yaml

from app.core.settings import Settings
from app.models.template import ScenarioTemplate


def list_templates(settings: Settings) -> list[ScenarioTemplate]:
    templates: list[ScenarioTemplate] = []
    for path in sorted(settings.templates_dir.glob("*.yaml")):
        templates.append(load_template(path))
    return templates


def get_template(settings: Settings, template_id: str) -> ScenarioTemplate | None:
    path = settings.templates_dir / f"{template_id}.yaml"
    if not path.exists():
        return None
    return load_template(path)


def load_template(path: Path) -> ScenarioTemplate:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return ScenarioTemplate.model_validate(raw)

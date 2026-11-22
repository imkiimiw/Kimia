"""Load config/*.yaml with ``${VAR}`` / ``${VAR:-default}`` expansion, then validate."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml
from dotenv import dotenv_values
from pydantic import ValidationError

from wanger_news.config.models import (
    AppConfig,
    CategoriesFile,
    EditorialFile,
    FiltersFile,
    PipelineConfig,
    RulesFile,
    SourcesFile,
)

_VAR = re.compile(r"\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}")

FILES = {
    "sources": "sources.yaml",
    "categories": "categories.yaml",
    "filters": "filters.yaml",
    "pipeline": "pipeline.yaml",
    "editorial": "editorial.yaml",
}
OPTIONAL_FILES = {"rules": "rules.yaml"}  # Phase 5: absent = no editorial rules


class ConfigError(Exception):
    pass


def environment(env_file: Path | None = Path(".env")) -> dict[str, str]:
    """Process environment over .env values (the process environment wins)."""
    merged: dict[str, str] = {}
    if env_file is not None and env_file.is_file():
        merged.update({k: v for k, v in dotenv_values(env_file).items() if v is not None})
    merged.update(os.environ)
    return merged


def expand(value: Any, env: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        return _VAR.sub(lambda m: env.get(m.group(1)) or (m.group(2) or ""), value)
    if isinstance(value, list):
        return [expand(v, env) for v in value]
    if isinstance(value, dict):
        return {k: expand(v, env) for k, v in value.items()}
    return value


def _read_yaml(path: Path, env: Mapping[str, str]) -> Any:
    if not path.is_file():
        raise ConfigError(f"missing config file: {path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path}: invalid YAML: {exc}") from exc
    return expand(data if data is not None else {}, env)


def load_config(config_dir: Path, env: Mapping[str, str] | None = None) -> AppConfig:
    env = environment() if env is None else env
    raw = {key: _read_yaml(config_dir / name, env) for key, name in FILES.items()}
    for key, name in OPTIONAL_FILES.items():
        raw[key] = _read_yaml(config_dir / name, env) if (config_dir / name).is_file() else {}
    try:
        return AppConfig(
            sources=SourcesFile.model_validate(raw["sources"]),
            categories=CategoriesFile.model_validate(raw["categories"]),
            filters=FiltersFile.model_validate(raw["filters"]),
            pipeline=PipelineConfig.model_validate(raw["pipeline"]),
            editorial=EditorialFile.model_validate(raw["editorial"]),
            rules=RulesFile.model_validate(raw["rules"]),
        )
    except ValidationError as exc:
        raise ConfigError(f"invalid configuration in {config_dir}:\n{exc}") from exc

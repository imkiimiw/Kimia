"""Versioned prompt files (spec §15): prompts/<name>.<lang>.vN.md with front matter.

The data an AI call works on (article text: untrusted) is placed between two markers carrying a
random boundary that an article cannot predict, as a JSON value (so it is escaped), and the
system instruction says it is data, not instructions (spec §3.3).
"""

from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

_FRONT = re.compile(r"\A---\n(.*?)\n---\n(.*)\Z", re.DOTALL)
_SECTION = re.compile(r"^## (system|user)\s*$", re.MULTILINE)
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


class PromptError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class RenderedPrompt:
    system: str
    user: str
    boundary: str


@dataclass(frozen=True, slots=True)
class Prompt:
    name: str
    version: str
    language: str
    system: str
    user: str

    def render(self, data: Any, schema: dict[str, Any], **values: str) -> RenderedPrompt:
        boundary = secrets.token_hex(8)
        payload = json.dumps(data, ensure_ascii=False, indent=1)
        fills = {
            "boundary": boundary,
            "data": payload,
            "schema": json.dumps(schema, ensure_ascii=False),
            **values,
        }
        missing = set(_PLACEHOLDER.findall(self.user)) - set(fills)
        if missing:
            raise PromptError(f"prompt {self.version}: missing values {sorted(missing)}")
        user = _PLACEHOLDER.sub(lambda m: fills[m.group(1)], self.user)
        return RenderedPrompt(system=self.system, user=user, boundary=boundary)


def parse_prompt(text: str, origin: str) -> Prompt:
    match = _FRONT.match(text.replace("\r\n", "\n"))
    if not match:
        raise PromptError(f"{origin}: missing front matter")
    meta = yaml.safe_load(match.group(1)) or {}
    parts = _SECTION.split(match.group(2))
    sections = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}
    for key in ("name", "version", "language"):
        if not meta.get(key):
            raise PromptError(f"{origin}: front matter needs {key!r}")
    if set(sections) != {"system", "user"}:
        raise PromptError(f"{origin}: needs exactly a '## system' and a '## user' section")
    if "{{data}}" not in sections["user"] or "{{boundary}}" not in sections["user"]:
        raise PromptError(f"{origin}: the user section must delimit {{data}} with {{boundary}}")
    return Prompt(
        name=str(meta["name"]),
        version=str(meta["version"]),
        language=str(meta["language"]),
        system=sections["system"],
        user=sections["user"],
    )


class PromptLibrary:
    """All prompt files of a folder; the highest version per (name, language) is current."""

    def __init__(self, prompts: list[Prompt]) -> None:
        self._prompts = prompts

    @classmethod
    def load(cls, folder: Path) -> PromptLibrary:
        if not folder.is_dir():
            raise PromptError(f"prompt folder not found: {folder}")
        prompts = [parse_prompt(p.read_text("utf-8"), p.name) for p in sorted(folder.glob("*.md"))]
        versions = [p.version for p in prompts]
        if len(versions) != len(set(versions)):
            raise PromptError("two prompt files declare the same version")
        return cls(prompts)

    def get(self, name: str, language: str = "any") -> Prompt:
        candidates = [
            p for p in self._prompts if p.name == name and p.language in (language, "any")
        ]
        if not candidates:
            raise PromptError(f"no prompt {name!r} for language {language!r}")
        exact = [p for p in candidates if p.language == language] or candidates
        return max(exact, key=lambda p: _version_number(p.version))

    @property
    def versions(self) -> list[str]:
        return sorted(p.version for p in self._prompts)


def _version_number(version: str) -> int:
    match = re.search(r"v(\d+)$", version)
    return int(match.group(1)) if match else 0

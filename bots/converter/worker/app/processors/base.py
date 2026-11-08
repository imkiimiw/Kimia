"""Processor plugins (spec §8): each declares an id, the input types it accepts and its operations.
An operation declares a short id (fits callback_data), a pydantic params schema, a queue, a timeout,
the engine features it needs, and `process(inputs, params, workdir, limits) -> Result`.
New tools are new modules; the core never changes."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict


class ToolError(Exception):
    """A refusal the user sees as a friendly text (code shared with the bot's err.<code>)."""

    def __init__(self, code: str, **vars_):
        super().__init__(code)
        self.code = code
        self.vars = vars_


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid")


@dataclass
class Input:
    path: Path
    name: str
    type: str  # detected type id from the bot (jpeg, png, …)


@dataclass
class Output:
    path: Path
    name: str
    mime: str
    type: str


@dataclass
class Result:
    outputs: list[Output] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    text: str | None = None  # a text result (OCR): delivered in the message or as a .txt


@dataclass
class Operation:
    id: str
    inputs: frozenset[str]
    params: type[Params]
    fn: Callable[[list[Input], Params, Path, dict], Result]
    queue: Literal["light", "heavy"] = "light"
    timeout_s: int = 30
    requires: tuple[str, ...] = ()
    min_inputs: int = 1
    max_inputs: int = 1
    group: str = "image"
    timeout_per_page_s: int = 0  # added per input page (the bot sends `pages` for PDFs)


@dataclass
class Processor:
    id: str
    operations: list[Operation]

"""Source reliability learning (Phase 5): a SUGGESTED new score from what happened to a
source's reports. Pure and explainable — every point of the change has a stated reason.
Nothing here changes a score: the owner applies a suggestion or not (history is kept).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from wanger_news.config.models import ReliabilityConfig
from wanger_news.domain.text import to_persian_digits


@dataclass(frozen=True, slots=True)
class Signals:
    approved: int = 0  # admins approved / published its items
    rejected: int = 0  # admins rejected them
    summarized: int = 0  # AI texts made from it
    guard_failed: int = 0  # of which the hallucination guard rejected
    claims: int = 0  # claims it supported
    confirmed: int = 0  # of which confirmed by another independent origin
    corrections: int = 0  # published corrections of stories it led

    def as_dict(self) -> dict[str, int]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


@dataclass(slots=True)
class Suggestion:
    old: int
    new: int
    parts: list[str] = field(default_factory=list)

    @property
    def change(self) -> int:
        return self.new - self.old


def _pct(value: float) -> str:
    return to_persian_digits(str(round(value * 100))) + "٪"


def suggest(current: int, s: Signals, cfg: ReliabilityConfig) -> Suggestion | None:
    """None when there is not enough evidence or the change would be too small."""
    delta = 0
    parts: list[str] = []
    decisions = s.approved + s.rejected
    if decisions >= cfg.min_samples:
        rate = s.approved / decisions
        d = round((rate - cfg.target_approval) * 20)
        delta += d
        parts.append(
            f"تأیید ادمین {_pct(rate)} از {to_persian_digits(str(decisions))} خبر ({d:+d})"
        )
    if s.claims >= cfg.min_samples:
        rate = s.confirmed / s.claims
        d = round((rate - 0.5) * 10)
        delta += d
        parts.append(f"تأیید ادعاها با منبع مستقل {_pct(rate)} ({d:+d})")
    if s.summarized >= cfg.min_samples:
        rate = s.guard_failed / s.summarized
        d = -round(rate * 20)
        delta += d
        parts.append(f"رد در بررسی ضدتوهم {_pct(rate)} ({d:+d})")
    if s.corrections:
        d = -3 * s.corrections
        delta += d
        parts.append(f"{to_persian_digits(str(s.corrections))} اصلاحیهٔ منتشرشده ({d:+d})")
    delta = max(-cfg.max_step, min(cfg.max_step, delta))
    if abs(delta) < cfg.min_change:
        return None
    new = max(0, min(100, current + delta))
    if new == current:
        return None
    return Suggestion(current, new, parts)

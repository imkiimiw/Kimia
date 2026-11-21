"""Related stories (Phase 4): earlier posts about a *different but connected* event — the same
people, places or subject. Pure; the score is stored so every link can be explained."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from wanger_news.config.models import RelatedConfig
from wanger_news.domain.similarity import cosine, overlap, shared_names


@dataclass(frozen=True, slots=True)
class Candidate:
    story_id: int
    centroid: list[float] | None
    names: list[str]


@dataclass(frozen=True, slots=True)
class Related:
    story_id: int
    score: float
    cosine: float
    overlap: float
    shared: list[str]

    def as_dict(self) -> dict[str, object]:
        return {
            "story_id": self.story_id,
            "score": round(self.score, 3),
            "cosine": round(self.cosine, 3),
            "overlap": round(self.overlap, 3),
            "shared": self.shared,
        }


def find_related(
    centroid: list[float] | None,
    names: Sequence[str],
    candidates: Sequence[Candidate],
    cfg: RelatedConfig,
) -> list[Related]:
    """Related when the meaning is close (cosine) or enough names are shared; best first."""
    found = []
    for cand in candidates:
        cos = cosine(centroid, cand.centroid) if centroid and cand.centroid else 0.0
        common = shared_names(names, cand.names)
        ov = overlap(names, cand.names)
        by_names = ov >= cfg.min_entity_overlap and len(common) >= cfg.min_shared_names
        if cos < cfg.min_cosine and not by_names:
            continue
        found.append(Related(cand.story_id, 0.7 * cos + 0.3 * ov, cos, ov, common))
    found.sort(key=lambda r: (-r.score, -r.story_id))
    return found[: cfg.max_links]

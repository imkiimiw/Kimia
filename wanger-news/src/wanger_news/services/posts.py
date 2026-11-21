"""Builds the channel post of an article from its Persian summary. The review card preview uses
the same builder, so an admin approves exactly what will be published."""

from __future__ import annotations

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article
from wanger_news.domain.scoring import label
from wanger_news.formatting.templates_fa import RenderedPost, SummaryPost, render_summary


class PostBuilder:
    def __init__(self, config: AppConfig) -> None:
        self._cfg = config

    def source_name(self, article: Article) -> str:
        source = self._cfg.source(article.source_id)
        return source.name if source else article.source_id

    async def build(self, repos: Repositories, article: Article) -> RenderedPost | None:
        """None when there is no Persian text to publish (no summary yet)."""
        summary = await repos.summaries.get(article.summary_id)
        if summary is None:
            return None
        images = article.images or []
        post = SummaryPost(
            title=summary.title,
            summary=summary.summary,
            key_points=list(summary.key_points or []),
            status=label(article.confidence_score or 0, self._cfg.pipeline.scoring),
            source_names=[self.source_name(article)],
            source_url=article.canonical_url or article.url or "",
            hashtags=list((article.classification or {}).get("hashtags") or []),
            image_url=images[0]["url"] if images else None,
        )
        return render_summary(post, self._cfg.pipeline.publish)

"""RULE-BASED CLASSIFY → GATE for stored items (``new`` → queued / filtered / pending_review)."""

from __future__ import annotations

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.domain.classify import RuleClassifier
from wanger_news.domain.enums import ArticleStatus, JobStatus, Stage, Transport
from wanger_news.domain.gate import Gate, GateInput
from wanger_news.domain.quality import assess
from wanger_news.services.context import RunContext

BATCH = 200


class ProcessingService:
    def __init__(self, config: AppConfig) -> None:
        self._cfg = config
        self._classifier = RuleClassifier(config.categories, config.pipeline.classification)
        self._gate = Gate(config.filters, config.pipeline.gate)

    async def run(self, repos: Repositories, ctx: RunContext) -> dict[str, int]:
        counts: dict[str, int] = {}
        while True:
            batch = await repos.articles.by_status(ArticleStatus.NEW, BATCH)
            if not batch:
                break
            for article in batch:
                now = ctx.now()
                source = self._cfg.source(article.source_id)
                default_category = source.category if source else "world"
                body = article.description_original or article.content_original
                cls = self._classifier.classify(article.title_original, body, default_category)
                human = article.transport == Transport.TELEGRAM_CHANNEL.value
                decision = self._gate.decide(
                    GateInput(
                        source_id=article.source_id,
                        country=article.country,
                        title=article.title_original,
                        body=body,
                        human_curated=human,
                    ),
                    cls,
                )
                quality = assess(
                    article.title_original,
                    body,
                    article.published_at is not None,
                    bool(article.canonical_url),
                    bool(article.images),
                )
                article.category = cls.category
                article.priority = (
                    self._cfg.pipeline.telegram.source_post_priority if human else cls.priority
                )
                article.sensitive = cls.sensitive
                article.quality_score = quality.score
                article.classification = {
                    **cls.explain(),
                    "hashtags": cls.hashtags,
                    "gate": decision.reason,
                    "quality": quality.breakdown,
                }
                status = decision.status
                if not human and status in (ArticleStatus.QUEUED, ArticleStatus.PENDING_REVIEW):
                    # Phase 2: feed items always get a validated Persian summary first; whether
                    # a human must review is decided after it (sensitive topics included)
                    status = ArticleStatus.AI_PENDING
                await repos.articles.set_status(article, status, now, decision.reason)
                await repos.jobs.record(
                    article.id,
                    Stage.CLASSIFY,
                    JobStatus.DONE,
                    ctx.run_id,
                    now,
                    details={"status": status.value, "reason": decision.reason},
                )
                counts[status.value] = counts.get(status.value, 0) + 1
            await repos.commit()
        return counts

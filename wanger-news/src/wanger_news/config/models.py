"""Typed, validated configuration files (config/*.yaml). Every threshold lives here, not in code."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from wanger_news.domain.chatref import ChatRef, ChatRefError
from wanger_news.domain.enums import SourceType, Transport


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --------------------------------------------------------------------------------------------
# sources.yaml
# --------------------------------------------------------------------------------------------


class RateLimitConfig(StrictModel):
    min_fetch_interval_minutes: int = Field(default=10, ge=0, le=1440)
    max_new_items_per_hour: int = Field(default=30, ge=1, le=1000)


class TelegramSourceConfig(StrictModel):
    """A Telegram channel the bot is admin of. Its posts are re-published (copied) if new."""

    chat: str = ""

    @property
    def chat_ref(self) -> ChatRef:
        return ChatRef.parse(self.chat)


class SourceConfig(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    name: str = Field(min_length=1, max_length=120)
    domain: str | None = None
    country: str | None = Field(default=None, pattern=r"^([A-Z]{2}|INT)$")
    language: str = Field(pattern=r"^[a-z]{2}$")
    category: str
    source_type: SourceType
    transport: Transport = Transport.RSS
    reliability_score: int = Field(ge=0, le=100)
    active: bool = True
    inactive_reason: str | None = None
    rss_url: str | None = None
    api_config: dict[str, Any] | None = None
    scraping_config: dict[str, Any] | None = None
    telegram: TelegramSourceConfig | None = None
    rate_limit: RateLimitConfig = RateLimitConfig()
    priority: int = Field(default=50, ge=0, le=100)
    owner_group: str | None = None
    notes: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _deactivate_unconfigured_telegram(cls, data: Any) -> Any:
        # `chat: ${WANGER_NEWS_SOURCE_CHANNEL}` with the variable unset → inactive, not an error.
        if isinstance(data, dict) and data.get("transport") == Transport.TELEGRAM_CHANNEL.value:
            chat = (data.get("telegram") or {}).get("chat", "")
            if not str(chat).strip() and data.get("active", True):
                data = {**data, "active": False, "inactive_reason": "chat not configured"}
        return data

    @model_validator(mode="after")
    def _check_transport(self) -> SourceConfig:
        if self.transport is Transport.RSS:
            if self.active and not self.rss_url:
                raise ValueError(f"source {self.id}: an active rss source needs rss_url")
            if self.rss_url and not self.rss_url.startswith(("https://", "http://")):
                raise ValueError(f"source {self.id}: rss_url must be http(s)")
        elif self.transport is Transport.TELEGRAM_CHANNEL:
            if self.telegram is None:
                raise ValueError(f"source {self.id}: a telegram_channel source needs `telegram`")
            if self.active:
                try:
                    self.telegram.chat_ref  # noqa: B018 — validates the reference
                except ChatRefError as exc:
                    raise ValueError(f"source {self.id}: {exc}") from exc
        elif self.active:
            raise ValueError(f"source {self.id}: transport {self.transport} is not implemented yet")
        return self

    @property
    def group(self) -> str:
        """Independence group: sources of one owner count as one (Phase 3 confidence)."""
        return self.owner_group or self.id


class SourcesFile(StrictModel):
    version: int = 1
    sources: list[SourceConfig]

    @field_validator("sources")
    @classmethod
    def _unique_ids(cls, sources: list[SourceConfig]) -> list[SourceConfig]:
        seen: set[str] = set()
        for source in sources:
            if source.id in seen:
                raise ValueError(f"duplicate source id: {source.id}")
            seen.add(source.id)
        return sources


# --------------------------------------------------------------------------------------------
# categories.yaml
# --------------------------------------------------------------------------------------------


class KeywordSet(StrictModel):
    """Keywords per language. A trailing ``*`` matches any word ending (``elect*``)."""

    en: list[str] = []
    fa: list[str] = []

    def all(self) -> list[str]:
        return [*self.en, *self.fa]


class CategoryConfig(StrictModel):
    id: str = Field(pattern=r"^[a-z][a-z_]{1,31}$")
    name_fa: str
    name_en: str
    hashtag: str = Field(pattern=r"^[^\s#]+$")
    base_priority: int | None = Field(default=None, ge=0, le=100)
    keywords: KeywordSet = KeywordSet()


class PriorityRule(StrictModel):
    priority: int = Field(ge=0, le=100)
    label: str
    keywords: KeywordSet


class SensitiveTopic(StrictModel):
    id: str
    name_fa: str
    keywords: KeywordSet


class CategoriesFile(StrictModel):
    version: int = 1
    default_priority: int = Field(default=50, ge=0, le=100)
    categories: list[CategoryConfig]
    priority_rules: list[PriorityRule] = []
    sensitive_topics: list[SensitiveTopic] = []

    @field_validator("categories")
    @classmethod
    def _unique(cls, categories: list[CategoryConfig]) -> list[CategoryConfig]:
        ids = [c.id for c in categories]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate category id")
        return categories

    def get(self, category_id: str) -> CategoryConfig | None:
        return next((c for c in self.categories if c.id == category_id), None)


# --------------------------------------------------------------------------------------------
# filters.yaml
# --------------------------------------------------------------------------------------------


class FilterLists(StrictModel):
    sources: list[str] = []
    keywords: list[str] = []
    countries: list[str] = []
    categories: list[str] = []


class FiltersFile(StrictModel):
    """Blacklist wins. A non-empty whitelist dimension means "only these"."""

    blacklist: FilterLists = FilterLists()
    whitelist: FilterLists = FilterLists()


# --------------------------------------------------------------------------------------------
# pipeline.yaml
# --------------------------------------------------------------------------------------------


class HttpConfig(StrictModel):
    user_agent: str = "WangerNewsBot/0.1 (RSS reader)"
    robots_user_agent: str = "WangerNewsBot"
    timeout_seconds: float = Field(default=15, gt=0, le=120)
    connect_timeout_seconds: float = Field(default=5, gt=0, le=60)
    max_response_bytes: int = Field(default=5_000_000, ge=10_000)
    max_redirects: int = Field(default=5, ge=0, le=10)
    retries: int = Field(default=2, ge=0, le=5)
    backoff_base_seconds: float = Field(default=0.5, ge=0)
    backoff_max_seconds: float = Field(default=8, ge=0)
    retry_after_max_seconds: float = Field(default=20, ge=0)
    concurrency: int = Field(default=6, ge=1, le=32)
    allowed_ports: list[int] = [80, 443]
    respect_robots_txt: bool = True
    robots_cache_hours: int = Field(default=24, ge=1)


class CircuitBreakerConfig(StrictModel):
    failure_threshold: int = Field(default=4, ge=1)
    cooldown_minutes: int = Field(default=30, ge=1)
    max_cooldown_minutes: int = Field(default=1440, ge=1)


class IngestConfig(StrictModel):
    max_entries_per_feed: int = Field(default=50, ge=1, le=500)
    max_item_age_hours: float = Field(default=12, gt=0)
    max_future_skew_minutes: int = Field(default=30, ge=0)
    min_title_chars: int = Field(default=8, ge=1)
    max_title_chars: int = Field(default=400, ge=20)
    max_description_chars: int = Field(default=4000, ge=100)
    max_content_chars: int = Field(default=20000, ge=100)


class DedupConfig(StrictModel):
    tracking_params: list[str] = []
    tracking_param_prefixes: list[str] = ["utm_"]
    strip_host_prefixes: list[str] = ["www.", "m."]
    near_duplicate_max_hamming: int = Field(default=12, ge=0, le=32)  # prefilter
    near_duplicate_min_jaccard: float = Field(default=0.8, gt=0, le=1)  # confirmation
    near_duplicate_same_numbers: bool = True
    near_duplicate_window_hours: int = Field(default=72, ge=1)
    near_duplicate_min_tokens: int = Field(default=8, ge=1)
    near_duplicate_max_candidates: int = Field(default=5000, ge=10)
    shingle_size: int = Field(default=2, ge=1, le=8)


class ClassificationConfig(StrictModel):
    title_weight: int = Field(default=3, ge=0)
    body_weight: int = Field(default=1, ge=0)
    min_category_score: int = Field(default=2, ge=1)
    secondary_hashtag_min_score: int = Field(default=4, ge=1)
    max_hashtags: int = Field(default=3, ge=0, le=3)


class GateConfig(StrictModel):
    min_priority: int = Field(default=50, ge=0, le=100)


class PublishConfig(StrictModel):
    max_posts_per_run: int = Field(default=6, ge=0, le=100)
    min_interval_seconds: float = Field(default=3, ge=0)
    max_publish_age_hours: float = Field(default=12, gt=0)
    description_excerpt_chars: int = Field(default=300, ge=0, le=900)
    use_feed_images: bool = True
    link_preview: bool = False
    max_attempts: int = Field(default=3, ge=1)
    message_limit: int = Field(default=4096, ge=100, le=4096)
    caption_limit: int = Field(default=1024, ge=100, le=1024)


class TelegramConfig(StrictModel):
    request_timeout_seconds: float = Field(default=20, gt=0)
    rate_limit_max_wait_seconds: float = Field(default=30, ge=0)
    poll_max_pages: int = Field(default=5, ge=1, le=50)
    album_settle_seconds: int = Field(default=20, ge=0)
    source_post_priority: int = Field(default=80, ge=0, le=100)
    notify_owner_on_duplicate: bool = True
    observe_target_channels: bool = True
    max_owner_notices_per_run: int = Field(default=5, ge=0)


class LocksConfig(StrictModel):
    pipeline_ttl_minutes: int = Field(default=15, ge=1)


class RetentionConfig(StrictModel):
    articles_days: int = Field(default=30, ge=1)
    jobs_days: int = Field(default=14, ge=1)
    updates_days: int = Field(default=7, ge=1)
    logs_days: int = Field(default=14, ge=1)
    batch_size: int = Field(default=2000, ge=10)


class WorkerConfig(StrictModel):
    interval_seconds: int = Field(default=600, ge=30)


class PipelineConfig(StrictModel):
    timezone: str = "Asia/Tehran"
    http: HttpConfig = HttpConfig()
    circuit_breaker: CircuitBreakerConfig = CircuitBreakerConfig()
    ingest: IngestConfig = IngestConfig()
    dedup: DedupConfig = DedupConfig()
    classification: ClassificationConfig = ClassificationConfig()
    gate: GateConfig = GateConfig()
    publish: PublishConfig = PublishConfig()
    telegram: TelegramConfig = TelegramConfig()
    locks: LocksConfig = LocksConfig()
    retention: RetentionConfig = RetentionConfig()
    worker: WorkerConfig = WorkerConfig()


class AppConfig(StrictModel):
    sources: SourcesFile
    categories: CategoriesFile
    filters: FiltersFile
    pipeline: PipelineConfig

    @model_validator(mode="after")
    def _cross_check(self) -> AppConfig:
        known = {c.id for c in self.categories.categories}
        for source in self.sources.sources:
            if source.category not in known:
                raise ValueError(f"source {source.id}: unknown category {source.category!r}")
        for listed in (self.filters.blacklist.categories, self.filters.whitelist.categories):
            unknown = set(listed) - known
            if unknown:
                raise ValueError(f"filters: unknown categories {sorted(unknown)}")
        return self

    def source(self, source_id: str) -> SourceConfig | None:
        return next((s for s in self.sources.sources if s.id == source_id), None)

    @property
    def active_sources(self) -> list[SourceConfig]:
        return [s for s in self.sources.sources if s.active]

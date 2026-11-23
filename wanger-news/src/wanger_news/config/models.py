"""Typed, validated configuration files (config/*.yaml). Every threshold lives here, not in code."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from wanger_news.domain.chatref import ChatRef, ChatRefError
from wanger_news.domain.enums import PublishMode, SourceType, Transport


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

    @property
    def switchable(self) -> bool:
        """May the owner switch this RSS source on/off in the bot? Active ones and inactive
        "Candidate" ones (waiting for the owner's choice) — never one that is off for a legal or
        technical reason (paywall, licence, broken feed)."""
        if self.transport is not Transport.RSS or not self.rss_url:
            return False
        return self.active or (self.inactive_reason or "").startswith("Candidate")

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


class SourcePostsConfig(StrictModel):
    """How source-channel posts reach the target channel (owner's decision, 2026-11-22):
    ``rebrand`` = re-sent without the source's Telegram IDs (@mentions, t.me links), with the
    target channel's @username and the poster's name as a hashtag; ``copy`` = copied unchanged."""

    mode: Literal["rebrand", "copy"] = "rebrand"
    channel_id_line: str = "🆔 @{username}"  # the target channel's @username ("" = none)
    author_line: str = "✍️ #{hashtag}"  # the poster's signature as a hashtag ("" = none)


class TelegramConfig(StrictModel):
    request_timeout_seconds: float = Field(default=20, gt=0)
    rate_limit_max_wait_seconds: float = Field(default=30, ge=0)
    poll_max_pages: int = Field(default=5, ge=1, le=50)
    album_settle_seconds: int = Field(default=20, ge=0)
    source_post_priority: int = Field(default=80, ge=0, le=100)
    notify_owner_on_duplicate: bool = True
    observe_target_channels: bool = True
    max_owner_notices_per_run: int = Field(default=5, ge=0)
    source_posts: SourcePostsConfig = SourcePostsConfig()


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


class AIConfig(StrictModel):
    """The AI stage (Phase 2). Quota numbers are conservative: free-tier limits are per Google
    project (see AI Studio → rate limits) and can be raised here."""

    enabled: bool = True
    provider: Literal["gemini"] = "gemini"
    model: str = "gemini-3.5-flash-lite"
    verify_model: str | None = None  # None → same as model
    api_base: str = "https://generativelanguage.googleapis.com/v1beta"
    schema_mode: Literal["json_schema", "prompt_only"] = "json_schema"
    thinking_level: str | None = "minimal"
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_output_tokens: int = Field(default=8192, ge=256)
    timeout_seconds: float = Field(default=90, gt=0)
    articles_per_call: int = Field(default=4, ge=1, le=10)
    max_input_chars_per_article: int = Field(default=6000, ge=500)
    max_calls_per_run: int = Field(default=24, ge=0)  # hard cap of one run (pacing below)
    # the daily quota when Google has not told us yet (a 429 "per day" answer carries the real
    # number, which then replaces this — stored in settings as ai.daily_quota)
    max_calls_per_day: int = Field(default=150, ge=0)
    pace_daily_quota: bool = True  # spread the daily quota evenly over the day
    run_interval_minutes: float = Field(default=10, gt=0)  # how often runs are triggered
    dry_run_max_calls: int = Field(default=2, ge=0)
    requests_per_minute: int = Field(default=8, ge=1)
    quota_reset_timezone: str = "America/Los_Angeles"
    max_attempts: int = Field(default=3, ge=1)
    verify: bool = True  # hallucination guard layer 2 (AI claim/evidence check)
    rewrite_on_failure: bool = True
    fallback_provider: str | None = None  # spec §13: only when configured (none implemented)
    # same provider, another model: tried when the model answers "overloaded" (500/503/504)
    fallback_models: list[str] = ["gemini-3.6-flash"]
    output_language: str = "fa"
    long_summary_min_importance: int = Field(default=70, ge=0, le=100)
    price_input_per_million: float = Field(default=0.30, ge=0)  # planning only (free tier = 0)
    price_output_per_million: float = Field(default=2.50, ge=0)

    @property
    def verifier(self) -> str:
        return self.verify_model or self.model


class GuardConfig(StrictModel):
    """Hallucination guard, layer 1 (deterministic)."""

    quote_min_similarity: float = Field(default=0.85, gt=0, le=1)
    evidence_min_similarity: float = Field(default=0.85, gt=0, le=1)
    max_title_chars: int = Field(default=160, ge=20)
    max_summary_chars: int = Field(default=2500, ge=200)
    max_key_points: int = Field(default=5, ge=0)


class StoryConfig(StrictModel):
    """Phase 3: story clustering (same event, spec §7) and multi-source processing."""

    enabled: bool = True
    embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = Field(default=768, ge=16, le=3072)
    embed_text_chars: int = Field(default=1200, ge=100)
    embed_batch_size: int = Field(default=100, ge=1, le=100)
    max_embed_calls_per_run: int = Field(default=3, ge=0)
    window_hours: float = Field(default=72, gt=0)
    max_candidates: int = Field(default=500, ge=10)
    # same event when cosine >= min_cosine AND (cosine >= strong_cosine OR shared names)
    min_cosine: float = Field(default=0.84, gt=0, le=1)
    strong_cosine: float = Field(default=0.92, gt=0, le=1)
    min_entity_overlap: float = Field(default=0.2, ge=0, le=1)
    time_full_hours: float = Field(default=6, gt=0)
    score_weights: dict[str, float] = {"cosine": 0.7, "entities": 0.2, "time": 0.1}
    settle_minutes: float = Field(default=15, ge=0)
    settle_skip_priority: int = Field(default=100, ge=0, le=100)
    syndication_min_jaccard: float = Field(default=0.6, gt=0, le=1)
    max_sources_per_story: int = Field(default=5, ge=1, le=10)
    max_input_chars_per_call: int = Field(default=30000, ge=2000)
    review_conflicts: bool = True


class BreakingConfig(StrictModel):
    """Phase 4: 🔴 breaking news (spec §10). Breaking never skips the guard or a human: it only
    changes the marker, the order and the speed (no settle wait, first in every queue)."""

    enabled: bool = True
    min_priority: int = Field(default=100, ge=0, le=100)  # rule priority (international crisis)
    min_importance: int = Field(default=85, ge=0, le=100)  # or the explainable importance score
    min_confidence: int = Field(default=50, ge=0, le=100)  # never for "unconfirmed" text
    max_age_minutes: float = Field(default=120, gt=0)  # since the story was first seen
    max_per_hour: int = Field(default=3, ge=0)  # more than this in a channel → posted as normal
    allow_updates: bool = False  # an update post is not breaking by default


class TrendsConfig(StrictModel):
    """Phase 4: trend detection / early warning (spec §16, Phase 4). A topic is a story (one
    event) or a name; "unusual" = many reports from several outlets compared with its own
    recent baseline. Counts only — no AI, nothing invented."""

    enabled: bool = True
    window_minutes: int = Field(default=60, ge=10, le=24 * 60)
    baseline_hours: float = Field(default=24, gt=1)
    min_reports: int = Field(default=5, ge=2)
    min_sources: int = Field(default=3, ge=1)  # distinct outlets (by owner group)
    max_reports_per_source: int = Field(default=2, ge=1)  # one noisy outlet cannot make a trend
    min_ratio: float = Field(default=3.0, ge=1)  # window count / usual count per window
    baseline_floor: float = Field(default=1.0, gt=0)  # "usual" is never taken as less than this
    # no alerts until the reports cover this much time (a new database knows no "usual")
    min_history_hours: float = Field(default=6, ge=0)
    cooldown_hours: float = Field(default=6, gt=0)  # one alert per topic in this time
    max_alerts_per_run: int = Field(default=3, ge=0)
    kinds: list[Literal["story", "entity"]] = ["story", "entity"]
    # a name whose window reports are mostly one trending story is not alerted separately
    entity_story_overlap: float = Field(default=0.8, gt=0, le=1)
    notify_admins: bool = True
    post_to_channel: bool = False  # the owner decides (PLAN.md); admins get every alert


class RelatedConfig(StrictModel):
    """Phase 4: links from a new post to earlier posts about related (not the same) events."""

    enabled: bool = True
    window_days: float = Field(default=7, gt=0)
    min_cosine: float = Field(default=0.75, gt=0, le=1)
    min_entity_overlap: float = Field(default=0.34, ge=0, le=1)
    min_shared_names: int = Field(default=2, ge=1)
    max_links: int = Field(default=2, ge=0, le=5)
    max_candidates: int = Field(default=300, ge=10)


class TimelineConfig(StrictModel):
    """Phase 4: a story's earlier posts, listed in an update post (and /timeline for admins)."""

    enabled: bool = True
    min_previous_posts: int = Field(default=2, ge=1)  # one earlier post is already the reply
    max_entries: int = Field(default=4, ge=1, le=10)


class DailyBriefConfig(StrictModel):
    """Phase 4: one brief a day of the stories already published (no new AI text)."""

    enabled: bool = True
    local_time: str = Field(default="21:00", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    max_late_hours: float = Field(default=3, gt=0)  # cron is late or runs stopped: skip the day
    window_hours: float = Field(default=24, gt=0)
    min_items: int = Field(default=3, ge=1)
    max_items: int = Field(default=10, ge=1, le=20)
    include_trends: bool = True
    destination: Literal["channel", "admins"] = "channel"


class CostsConfig(StrictModel):
    """Phase 5: cost tracking. The free tier costs nothing; the estimate (ai.price_*) shows what
    the same use would cost on a paid plan. Budget 0 = no alert."""

    monthly_budget_usd: float = Field(default=0, ge=0)
    alert_at_fraction: float = Field(default=0.8, gt=0, le=1)


class ReliabilityConfig(StrictModel):
    """Phase 5: source reliability learning — SUGGESTIONS only; the owner applies them."""

    enabled: bool = True
    every_days: float = Field(default=7, gt=0)
    window_days: float = Field(default=30, gt=0)
    min_samples: int = Field(default=5, ge=1)  # per signal, below this the signal is ignored
    min_change: int = Field(default=3, ge=1)  # smaller changes are not worth a suggestion
    max_step: int = Field(default=10, ge=1, le=50)  # per suggestion
    target_approval: float = Field(default=0.75, ge=0, le=1)


class ScoringConfig(StrictModel):
    """Explainable importance and confidence (spec §8). Weights are relative."""

    importance_weights: dict[str, float] = {
        "rule_priority": 2.0,
        "people_affected": 1.0,
        "significance": 1.5,
        "severity": 1.0,
        "geographic_scope": 1.0,
        "continuation": 0.5,
        "international_impact": 1.0,
        "recency": 0.5,
    }
    recency_full_hours: float = Field(default=2, ge=0)
    recency_zero_hours: float = Field(default=24, gt=0)
    confidence_weights: dict[str, float] = {
        "reliability": 0.4,
        "independent_sources": 0.2,
        "primary_source": 0.1,
        "quality": 0.1,
        "guard": 0.15,
        "consistency": 0.05,
    }
    independent_source_scores: dict[int, int] = {1: 40, 2: 75, 3: 100}
    conflict_cap: int = Field(default=69, ge=0, le=100)  # conflicting reports are never "confirmed"
    likely_min_reliability: int = Field(default=80, ge=0, le=100)  # one strong primary = "likely"
    primary_source_types: list[SourceType] = [
        SourceType.NEWS_AGENCY,
        SourceType.GOVERNMENT,
        SourceType.OFFICIAL_ORGANIZATION,
    ]
    primary_source_score: int = Field(default=100, ge=0, le=100)
    secondary_source_score: int = Field(default=60, ge=0, le=100)
    guard_scores: dict[str, int] = {"passed": 100, "after_rewrite": 80, "human": 90, "failed": 0}
    single_source_cap: int = Field(default=69, ge=0, le=100)
    guard_failed_cap: int = Field(default=49, ge=0, le=100)  # failed verification = unconfirmed
    label_thresholds: dict[str, int] = {"confirmed": 90, "likely": 70, "preliminary": 50}


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
    ai: AIConfig = AIConfig()
    guard: GuardConfig = GuardConfig()
    scoring: ScoringConfig = ScoringConfig()
    story: StoryConfig = StoryConfig()
    breaking: BreakingConfig = BreakingConfig()
    trends: TrendsConfig = TrendsConfig()
    related: RelatedConfig = RelatedConfig()
    timeline: TimelineConfig = TimelineConfig()
    daily_brief: DailyBriefConfig = DailyBriefConfig()
    costs: CostsConfig = CostsConfig()
    reliability: ReliabilityConfig = ReliabilityConfig()


# --------------------------------------------------------------------------------------------
# editorial.yaml
# --------------------------------------------------------------------------------------------


class PublishModes(StrictModel):
    default: PublishMode = PublishMode.SEMI
    categories: dict[str, PublishMode] = {}

    def for_category(self, category: str | None) -> PublishMode:
        return self.categories.get(category or "", self.default)


class AutoPublishConfig(StrictModel):
    # spec §8: below 50 is "unconfirmed" and is never published automatically
    min_confidence: int = Field(default=50, ge=50, le=100)
    min_importance: int = Field(default=50, ge=0, le=100)


class ReviewConfig(StrictModel):
    max_cards_per_run: int = Field(default=5, ge=0, le=50)
    expire_after_hours: float = Field(default=12, gt=0)
    send_to: Literal["owner", "all_admins"] = "all_admins"
    preview_chars: int = Field(default=2500, ge=300, le=3500)


class EditorialFile(StrictModel):
    version: int = 1
    publish_modes: PublishModes = PublishModes()
    auto_publish: AutoPublishConfig = AutoPublishConfig()
    review: ReviewConfig = ReviewConfig()


# --------------------------------------------------------------------------------------------
# rules.yaml (Phase 5: editorial rules engine, spec §11)
# --------------------------------------------------------------------------------------------

RULE_ACTIONS = ("require_human_review", "hold", "skip", "merge", "new_story")
PRIORITY_WORDS = {"high": 100, "normal": 50, "low": 20}


class RuleCondition(StrictModel):
    """Every condition given must hold (AND). Lists mean "any of"."""

    category: str | list[str] | None = None
    source: str | list[str] | None = None
    source_type: SourceType | list[SourceType] | None = None
    language: str | list[str] | None = None
    sensitive: bool | None = None
    sensitive_topic: str | list[str] | None = None
    breaking: bool | None = None
    contradiction: bool | None = None
    kind: Literal["story", "update"] | None = None
    confidence_lt: int | None = None
    confidence_gte: int | None = None
    importance_gt: int | None = None
    importance_lte: int | None = None
    priority_gte: int | None = None
    priority_lt: int | None = None
    independent_sources_lt: int | None = None
    independent_sources_gte: int | None = None
    keyword_any: list[str] | None = None  # in the original title/teaser (case-insensitive)
    duplicate_similarity_gt: float | None = Field(default=None, gt=0, le=1)  # cluster stage

    @model_validator(mode="after")
    def _not_empty(self) -> RuleCondition:
        if not self.model_dump(exclude_none=True):
            raise ValueError("a rule needs at least one condition")
        return self


class RuleSet(StrictModel):
    """What a rule does. A rule only makes things stricter or changes order: it never lets an
    item skip the guard, a sensitive-topic review or the "confidence ≥ 50" floor."""

    priority: int | Literal["high", "normal", "low"] | None = None
    mode: PublishMode | None = None

    @property
    def priority_value(self) -> int | None:
        if self.priority is None:
            return None
        if isinstance(self.priority, str):
            return PRIORITY_WORDS[self.priority]
        return max(0, min(100, self.priority))


class Rule(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,40}$")
    description: str = ""
    enabled: bool = True
    when: RuleCondition = Field(alias="if")
    then: Literal["require_human_review", "hold", "skip", "merge", "new_story"] | RuleSet

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @model_validator(mode="after")
    def _stage_fits(self) -> Rule:
        cluster_only = self.when.duplicate_similarity_gt is not None
        cluster_action = self.then in ("merge", "new_story")
        if cluster_only != cluster_action:
            raise ValueError(
                f"rule {self.id}: duplicate_similarity_gt goes with merge/new_story (cluster stage)"
            )
        return self


class RulesFile(StrictModel):
    version: int = 1
    rules: list[Rule] = []

    @field_validator("rules")
    @classmethod
    def _unique(cls, rules: list[Rule]) -> list[Rule]:
        ids = [r.id for r in rules]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate rule id")
        return rules


class AppConfig(StrictModel):
    sources: SourcesFile
    categories: CategoriesFile
    filters: FiltersFile
    pipeline: PipelineConfig
    editorial: EditorialFile = EditorialFile()
    rules: RulesFile = RulesFile()

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
        unknown_modes = set(self.editorial.publish_modes.categories) - known
        if unknown_modes:
            raise ValueError(f"editorial: unknown categories {sorted(unknown_modes)}")
        topics = {t.id for t in self.categories.sensitive_topics}
        sources = {s.id for s in self.sources.sources}
        for rule in self.rules.rules:
            for field_name, valid in (
                ("category", known),
                ("sensitive_topic", topics),
                ("source", sources),
            ):
                value = getattr(rule.when, field_name)
                given = {value} if isinstance(value, str) else set(value or [])
                if given - valid:
                    raise ValueError(
                        f"rule {rule.id}: unknown {field_name} {sorted(given - valid)}"
                    )
        return self

    def source(self, source_id: str) -> SourceConfig | None:
        return next((s for s in self.sources.sources if s.id == source_id), None)

    @property
    def active_sources(self) -> list[SourceConfig]:
        return [s for s in self.sources.sources if s.active]

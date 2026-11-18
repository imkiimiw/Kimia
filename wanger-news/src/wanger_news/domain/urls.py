"""URL normalization for exact-duplicate detection (level 1)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit

_DEFAULT_PORTS = {"http": 80, "https": 443}
_MULTI_SLASH = re.compile(r"/{2,}")


@dataclass(frozen=True, slots=True)
class UrlPolicy:
    """Which query parameters and host prefixes are noise. Comes from config/pipeline.yaml."""

    tracking_params: frozenset[str] = field(default_factory=frozenset)
    tracking_prefixes: tuple[str, ...] = ()
    strip_host_prefixes: tuple[str, ...] = ("www.",)

    def is_tracking(self, key: str) -> bool:
        low = key.lower()
        return low in self.tracking_params or any(low.startswith(p) for p in self.tracking_prefixes)


def _normalize_path(path: str) -> str:
    # Decode then re-encode so equivalent percent-encodings compare equal.
    path = quote(unquote(path), safe="/:@!$&'()*+,;=-._~%")
    path = _MULTI_SLASH.sub("/", path) or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    return path


def normalize_url(raw: str, policy: UrlPolicy) -> str | None:
    """Canonical form of an http(s) URL, or None when it is not a usable web URL.

    - lower-case scheme and host, IDNA host, no default port, no ``user:pass@``
    - host prefixes like ``www.`` removed
    - tracking parameters (utm_*, fbclid, …) removed, the rest sorted
    - fragment removed, duplicate and trailing slashes removed
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname:
        return None
    host = parts.hostname.rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    for prefix in policy.strip_host_prefixes:
        if host.startswith(prefix) and host.count(".") >= 2:
            host = host[len(prefix) :]
            break
    netloc = host if port in (None, _DEFAULT_PORTS[scheme]) else f"{host}:{port}"
    query_items = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not policy.is_tracking(k)
    ]
    query = urlencode(sorted(query_items), doseq=True)
    return urlunsplit((scheme, netloc, _normalize_path(parts.path), query, ""))


def url_key(canonical_url: str) -> str:
    """Scheme-less form, so http:// and https:// copies of a link match each other."""
    return canonical_url.split("://", 1)[-1]


def domain_of(url: str) -> str | None:
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return None
    return host.lower() if host else None

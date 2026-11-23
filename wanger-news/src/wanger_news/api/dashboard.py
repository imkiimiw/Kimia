"""Web dashboard (Phase 6, option B): a static page over the admin API.

Three files (``api/static``), no build step and no third-party script. The page holds no data:
it asks for the admin token, keeps it in ``sessionStorage`` (gone when the tab closes) and calls
the ``/api/*`` routes with it — so it can do exactly what the API (= the bot's buttons) can.
Strict Content-Security-Policy: only this origin's own script and styles, no framing.
"""

from __future__ import annotations

from importlib import resources

from fastapi import FastAPI
from fastapi.responses import Response

CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-cache",
}
FILES = {
    "/dashboard": ("dashboard.html", "text/html; charset=utf-8"),
    "/dashboard/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/dashboard/app.css": ("app.css", "text/css; charset=utf-8"),
}


def _read(name: str) -> bytes:
    return resources.files("wanger_news.api").joinpath("static", name).read_bytes()


def mount_dashboard(app: FastAPI) -> None:
    for path, (name, media_type) in FILES.items():
        body = _read(name)

        def serve(body: bytes = body, media_type: str = media_type) -> Response:
            return Response(content=body, media_type=media_type, headers=HEADERS)

        app.add_api_route(path, serve, methods=["GET"], include_in_schema=False)

"""Minimal Bot API client for the worker. It may only download files and send/edit messages (spec §2):
methods outside ALLOWED raise before any request, so setWebhook / deleteWebhook / getUpdates are
impossible by construction (the Serverless platform owns the webhook). The token never appears in
logs (httpx request logging is silenced in logs.setup; errors carry only method names)."""
from __future__ import annotations

import json
import mimetypes
import time
from pathlib import Path

import httpx

ALLOWED = frozenset({"getMe", "getFile", "sendMessage", "editMessageText", "sendDocument", "sendMediaGroup",
                     "deleteMessage"})


class TelegramError(Exception):
    def __init__(self, code: str, description: str = "", method: str = ""):
        super().__init__(f"{method}: {code}")
        self.code = code
        self.description = description
        self.method = method


def classify(status: int, description: str) -> str:
    d = description.lower()
    if status == 429:
        return "RATE_LIMITED"
    if status == 403:
        return "USER_BLOCKED"
    if "file is too big" in d or "request entity too large" in d or status == 413:
        return "TOO_BIG"
    if "wrong file_id" in d or "file not found" in d or "invalid file_id" in d or "temporarily unavailable" in d:
        return "FILE_GONE"
    if "message is not modified" in d:
        return "NOT_MODIFIED"
    if "message to edit not found" in d or "message to delete not found" in d or "message can't be edited" in d:
        return "MESSAGE_GONE"
    if status >= 500:
        return "TELEGRAM_DOWN"
    return "BAD_REQUEST"


class Telegram:
    def __init__(self, token: str, base: str = "https://api.telegram.org", client: httpx.Client | None = None,
                 retries: int = 3, sleep=time.sleep):
        self._token = token
        self._base = base.rstrip("/")
        self._client = client or httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))
        self._retries = retries
        self._sleep = sleep

    def call(self, method: str, data: dict | None = None, files: dict | None = None):
        if method not in ALLOWED:
            raise ValueError(f"Bot API method not allowed for the worker: {method}")
        url = f"{self._base}/bot{self._token}/{method}"
        form = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v))
                for k, v in (data or {}).items() if v is not None}
        attempt = 0
        while True:
            attempt += 1
            try:
                if files:
                    for f in files.values():  # rewind file objects on retries
                        f[1].seek(0)
                    res = self._client.post(url, data=form, files=files)
                else:
                    res = self._client.post(url, data=form)
            except httpx.HTTPError as exc:
                if attempt <= self._retries:
                    self._sleep(min(2 ** attempt, 10))
                    continue
                raise TelegramError("NETWORK", type(exc).__name__, method) from None
            try:
                body = res.json()
            except ValueError:
                body = {"ok": False, "description": f"HTTP {res.status_code}"}
            if body.get("ok"):
                return body.get("result")
            desc = str(body.get("description", ""))
            code = classify(res.status_code, desc)
            retry_after = (body.get("parameters") or {}).get("retry_after")
            if code == "RATE_LIMITED" and attempt <= self._retries and retry_after is not None and retry_after <= 30:
                self._sleep(float(retry_after) + 0.5)
                continue
            if code == "TELEGRAM_DOWN" and attempt <= self._retries:
                self._sleep(min(2 ** attempt, 10))
                continue
            raise TelegramError(code, desc[:200], method)

    # ---- files ----------------------------------------------------------------------------------
    def download(self, file_id: str, dest: Path, max_bytes: int) -> int:
        info = self.call("getFile", {"file_id": file_id})
        size = info.get("file_size")
        if size is not None and size > max_bytes:
            raise TelegramError("TOO_BIG", "", "getFile")
        path = info.get("file_path")
        if not path:
            raise TelegramError("FILE_GONE", "no file_path", "getFile")
        url = f"{self._base}/file/bot{self._token}/{path}"
        total = 0
        try:
            with self._client.stream("GET", url) as res:
                if res.status_code == 404:
                    raise TelegramError("FILE_GONE", "", "download")
                if res.status_code != 200:
                    raise TelegramError("DOWNLOAD_FAILED", f"HTTP {res.status_code}", "download")
                with open(dest, "wb") as out:
                    for chunk in res.iter_bytes(1 << 16):
                        total += len(chunk)
                        if total > max_bytes:
                            raise TelegramError("TOO_BIG", "", "download")
                        out.write(chunk)
        except httpx.HTTPError as exc:
            raise TelegramError("DOWNLOAD_FAILED", type(exc).__name__, "download") from None
        if size is not None and total != size:
            raise TelegramError("DOWNLOAD_FAILED", "short read", "download")
        return total

    # ---- messages ------------------------------------------------------------------------------
    @staticmethod
    def _reply(reply_to: int | None) -> dict | None:
        return {"message_id": reply_to, "allow_sending_without_reply": True} if reply_to else None

    def send_message(self, chat_id: int, text: str, reply_to: int | None = None, reply_markup: dict | None = None):
        return self.call("sendMessage", {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                                         "link_preview_options": {"is_disabled": True},
                                         "reply_parameters": self._reply(reply_to), "reply_markup": reply_markup})

    def edit_text(self, chat_id: int, message_id: int, text: str, reply_markup: dict | None = None) -> bool:
        """True when edited; False when the message is gone or unchanged (the caller may send instead)."""
        try:
            self.call("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": text,
                                          "parse_mode": "HTML", "link_preview_options": {"is_disabled": True},
                                          "reply_markup": reply_markup})
            return True
        except TelegramError as e:
            if e.code in ("NOT_MODIFIED",):
                return True
            if e.code in ("MESSAGE_GONE", "BAD_REQUEST"):
                return False
            raise

    def send_document(self, chat_id: int, path: Path, name: str, mime: str | None = None, caption: str | None = None,
                      reply_to: int | None = None, reply_markup: dict | None = None):
        mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
        with open(path, "rb") as fh:
            return self.call("sendDocument", {
                "chat_id": chat_id, "caption": caption, "parse_mode": "HTML" if caption else None,
                "disable_content_type_detection": "true", "reply_parameters": self._reply(reply_to),
                "reply_markup": reply_markup}, files={"document": (name, fh, mime)})

    def send_document_group(self, chat_id: int, items: list[tuple[Path, str, str]], reply_to: int | None = None):
        """2–10 documents as one album; returns the sent messages."""
        handles = []
        try:
            files, media = {}, []
            for i, (path, name, mime) in enumerate(items):
                fh = open(path, "rb")
                handles.append(fh)
                files[f"f{i}"] = (name, fh, mime)
                media.append({"type": "document", "media": f"attach://f{i}"})
            return self.call("sendMediaGroup", {"chat_id": chat_id, "media": media,
                                                "reply_parameters": self._reply(reply_to)}, files=files)
        finally:
            for fh in handles:
                fh.close()

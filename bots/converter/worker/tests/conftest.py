import io
import json
import sys
import time
from pathlib import Path

import httpx
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.telegram import Telegram  # noqa: E402

TOKEN = "123456789:AAH-test-token-abcdefghijklmnopqrstuvwxyz"
SECRET = "s" * 40
LIMITS = {"max_input_mb": 20, "max_output_mb": 50, "max_image_pixels": 50_000_000, "max_side": 12000}


@pytest.fixture
def settings(tmp_path):
    return Settings(bot_token=TOKEN, worker_secret=SECRET, data_dir=tmp_path / "data", tmp_dir=tmp_path / "tmp",
                    telegram_api="https://tg.test", timeout_light_s=20, temp_retention_min=30)


class FakeTelegram:
    """Bot API over httpx.MockTransport: files by file_id, every call recorded."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.calls: list[tuple[str, dict, dict]] = []
        self.fail: dict[str, tuple[int, str]] = {}
        self.n = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith(f"/file/bot{TOKEN}/"):
            fid = path.rsplit("/", 1)[1]
            return httpx.Response(200, content=self.files[fid]) if fid in self.files else httpx.Response(404)
        method = path.rsplit("/", 1)[1]
        assert path == f"/bot{TOKEN}/{method}"
        form, files = self._parse(request)
        self.calls.append((method, form, files))
        if method in self.fail:
            status, desc = self.fail[method]
            return httpx.Response(status, json={"ok": False, "error_code": status, "description": desc})
        if method == "getFile":
            fid = form["file_id"]
            if fid not in self.files:
                return httpx.Response(400, json={"ok": False, "description": "Bad Request: wrong file_id"})
            return httpx.Response(200, json={"ok": True, "result": {"file_id": fid, "file_size": len(self.files[fid]),
                                                                    "file_path": f"documents/{fid}"}})
        self.n += 1
        if method == "sendDocument":
            name, data = files["document"]
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 1000 + self.n, "document": {
                "file_id": f"out-{self.n}", "file_unique_id": f"u{self.n}", "file_name": name,
                "file_size": len(data)}}})
        if method == "sendMediaGroup":
            media = json.loads(form["media"])
            res = []
            for i, m in enumerate(media):
                name, data = files[m["media"].split("//")[1]]
                res.append({"message_id": 2000 + self.n * 10 + i, "document": {
                    "file_id": f"grp-{self.n}-{i}", "file_unique_id": f"g{self.n}{i}", "file_name": name,
                    "file_size": len(data)}})
            return httpx.Response(200, json={"ok": True, "result": res})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 3000 + self.n} if method == "sendMessage" else True})

    @staticmethod
    def _parse(request: httpx.Request):
        ctype = request.headers.get("content-type", "")
        body = request.read()
        if ctype.startswith("application/x-www-form-urlencoded"):
            from urllib.parse import parse_qsl
            return dict(parse_qsl(body.decode())), {}
        if ctype.startswith("multipart/form-data"):
            import email.parser
            import email.policy
            msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
            form, files = {}, {}
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                filename = part.get_filename()
                payload = part.get_payload(decode=True)
                if filename is not None:
                    files[name] = (filename, payload)
                else:
                    form[name] = payload.decode()
            return form, files
        return {}, {}

    def methods(self):
        return [c[0] for c in self.calls]

    def client(self) -> Telegram:
        return Telegram(TOKEN, "https://tg.test", client=httpx.Client(transport=httpx.MockTransport(self.handler)),
                        sleep=lambda s: None)


@pytest.fixture
def fake_tg():
    return FakeTelegram()


def img_bytes(fmt="PNG", size=(64, 48), mode="RGB", color=(200, 30, 30), **save):
    im = Image.new(mode, size, color)
    buf = io.BytesIO()
    im.save(buf, format=fmt, **save)
    return buf.getvalue()


def wait_for(fn, timeout=20.0, step=0.05):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    raise AssertionError("condition not met in time")

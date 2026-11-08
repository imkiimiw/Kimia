import httpx
import pytest

from app.telegram import Telegram, TelegramError
from tests.conftest import TOKEN


def client(handler):
    return Telegram(TOKEN, "https://tg.test", client=httpx.Client(transport=httpx.MockTransport(handler)),
                    sleep=lambda s: None)


@pytest.mark.parametrize("method", ["setWebhook", "deleteWebhook", "getUpdates", "logOut", "close", "setMyCommands"])
def test_webhook_and_polling_methods_are_impossible(method):
    calls = []
    tg = client(lambda r: calls.append(r) or httpx.Response(200, json={"ok": True, "result": True}))
    with pytest.raises(ValueError):
        tg.call(method, {})
    assert calls == []


def test_retries_after_429_then_succeeds():
    n = [0]

    def h(r):
        n[0] += 1
        if n[0] == 1:
            return httpx.Response(429, json={"ok": False, "description": "Too Many Requests",
                                             "parameters": {"retry_after": 1}})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})
    assert client(h).send_message(1, "hi") == {"message_id": 1}
    assert n[0] == 2


def test_download_stops_at_the_size_limit(tmp_path):
    def h(r):
        if r.url.path.endswith("getFile"):
            return httpx.Response(200, json={"ok": True, "result": {"file_path": "a/b"}})  # no file_size declared
        return httpx.Response(200, content=b"x" * 5000)
    with pytest.raises(TelegramError) as e:
        client(h).download("F", tmp_path / "f", 1000)
    assert e.value.code == "TOO_BIG"


def test_declared_size_over_the_limit_is_refused_before_downloading(tmp_path):
    seen = []

    def h(r):
        seen.append(r.url.path)
        return httpx.Response(200, json={"ok": True, "result": {"file_path": "a/b", "file_size": 10_000}})
    with pytest.raises(TelegramError):
        client(h).download("F", tmp_path / "f", 1000)
    assert len(seen) == 1


def test_errors_carry_no_token():
    tg = client(lambda r: httpx.Response(400, json={"ok": False, "description": "Bad Request: wrong file_id"}))
    with pytest.raises(TelegramError) as e:
        tg.call("getFile", {"file_id": "x"})
    assert e.value.code == "FILE_GONE" and TOKEN not in str(e.value) and TOKEN not in repr(e.value)


def test_network_errors_carry_no_url():
    def h(r):
        raise httpx.ConnectError("boom", request=r)
    with pytest.raises(TelegramError) as e:
        client(h).call("getMe")
    assert e.value.code == "NETWORK" and TOKEN not in str(e.value) and e.value.__cause__ is None


def test_edit_of_a_deleted_message_reports_false():
    tg = client(lambda r: httpx.Response(400, json={"ok": False, "description": "Bad Request: message to edit not found"}))
    assert tg.edit_text(1, 2, "x") is False

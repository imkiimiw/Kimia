import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import sign
from tests.conftest import SECRET, TOKEN, img_bytes, wait_for

_n = [0]


def signed(client, method, path, body=None, ts=None, secret=SECRET, nonce=None):
    raw = json.dumps(body).encode() if body is not None else b""
    _n[0] += 1
    ts = ts or int(time.time())
    nonce = nonce or f"test-nonce-{_n[0]:012d}"
    headers = {"X-Wanger-Timestamp": str(ts), "X-Wanger-Nonce": nonce,
               "X-Wanger-Signature": sign(secret, ts, nonce, method, path, raw), "Content-Type": "application/json"}
    return client.request(method, path, content=raw, headers=headers)


def job_body(i=1, op="img.gr", inputs=None, params=None, user=7, **kw):
    return {"job_id": f"01JOB{i:021d}", "code": f"WC-{i:06d}", "user_id": user, "chat_id": user, "lang": "fa",
            "op": op, "inputs": inputs if inputs is not None else [{"file_id": "F1", "name": "photo.png", "type": "png",
                                                                       "size": 100}],
            "params": params or {}, "status_message_id": 55, "reply_to": 54, **kw}


@pytest.fixture
def api(settings, fake_tg):
    app = create_app(settings, tg=fake_tg.client(), run_workers=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def live(settings, fake_tg):
    app = create_app(settings, tg=fake_tg.client(), run_workers=True)
    with TestClient(app) as c:
        yield c


def test_health_endpoints_need_no_auth_and_say_little(api):
    assert api.get("/healthz").json() == {"ok": True}
    assert api.get("/readyz").json() == {"ok": True}
    assert api.get("/docs").status_code == 404 and api.get("/openapi.json").status_code == 404


def test_v1_requires_a_valid_signature(api):
    assert api.get("/v1/capabilities").status_code == 401
    r = signed(api, "GET", "/v1/capabilities", secret="w" * 40)
    assert r.status_code == 401 and r.json() == {"error": "BAD_SIGNATURE"}
    r = signed(api, "GET", "/v1/capabilities", ts=int(time.time()) - 1000)
    assert r.json() == {"error": "STALE_TIMESTAMP"}
    r = signed(api, "GET", "/v1/capabilities")
    assert r.status_code == 200
    caps = r.json()
    assert "img.cv" in caps["ops"] and "tti" in caps["ops"] and "png" in caps["formats"]["image_write"]


def test_replayed_request_is_refused(api):
    ts = int(time.time())
    nonce = "replay-nonce-000000001"
    h = {"X-Wanger-Timestamp": str(ts), "X-Wanger-Nonce": nonce,
         "X-Wanger-Signature": sign(SECRET, ts, nonce, "GET", "/v1/health", b"")}
    assert api.get("/v1/health", headers=h).status_code == 200
    assert api.get("/v1/health", headers=h).json() == {"error": "REPLAY"}


def test_query_string_is_part_of_the_signature(api):
    ts = int(time.time())
    nonce = "query-nonce-0000000001"
    sig = sign(SECRET, ts, nonce, "GET", "/v1/jobs/01JOB000000000000000000001?user_id=7", b"")
    r = api.get("/v1/jobs/01JOB000000000000000000001?user_id=8",
                headers={"X-Wanger-Timestamp": str(ts), "X-Wanger-Nonce": nonce, "X-Wanger-Signature": sig})
    assert r.status_code == 401


def test_body_size_is_capped(api):
    r = signed(api, "POST", "/v1/jobs", {"x": "a" * 70000})
    assert r.status_code == 413


def test_submit_validates_everything(api):
    assert signed(api, "POST", "/v1/jobs", job_body(op="nope")).json()["error"] == "UNKNOWN_OP"
    assert signed(api, "POST", "/v1/jobs", job_body(inputs=[])).json()["error"] == "BAD_INPUTS"
    bad_type = [{"file_id": "F", "name": "a.pdf", "type": "pdf", "size": 1}]
    assert signed(api, "POST", "/v1/jobs", job_body(inputs=bad_type)).json()["error"] == "BAD_INPUT_TYPE"
    big = [{"file_id": "F", "name": "a.png", "type": "png", "size": 30 * 1024 * 1024}]
    assert signed(api, "POST", "/v1/jobs", job_body(inputs=big)).json()["error"] == "TOO_BIG"
    r = signed(api, "POST", "/v1/jobs", job_body(op="img.rs", params={"mode": "zoom"}))
    assert r.json()["error"] == "BAD_PARAMS" and r.json()["fields"] == ["mode"]
    r = signed(api, "POST", "/v1/jobs", job_body(op="img.cv", params={"format": "png", "evil": 1}))
    assert r.json()["error"] == "BAD_PARAMS"
    r = signed(api, "POST", "/v1/jobs", {**job_body(), "job_id": "../../x"})
    assert r.json()["error"] == "BAD_REQUEST"


def test_submit_is_idempotent_and_jobs_are_private(api, fake_tg):
    r1 = signed(api, "POST", "/v1/jobs", job_body(5))
    r2 = signed(api, "POST", "/v1/jobs", job_body(5))
    assert r1.status_code == 202 and r2.status_code == 200
    assert r1.json()["job"]["status"] == "QUEUED" and r1.json()["job"]["position"] == 1
    jid = job_body(5)["job_id"]
    assert signed(api, "GET", f"/v1/jobs/{jid}?user_id=7").json()["job"]["code"] == "WC-000005"
    assert signed(api, "GET", f"/v1/jobs/{jid}?user_id=8").status_code == 404
    assert signed(api, "DELETE", f"/v1/jobs/{jid}?user_id=8").status_code == 404
    assert signed(api, "DELETE", f"/v1/jobs/{jid}?user_id=7").json()["job"]["status"] == "CANCELLED"
    wait_for(lambda: any(c[0] == "editMessageText" and "WC-000005" in c[1].get("text", "") for c in fake_tg.calls))


def test_end_to_end_job_downloads_processes_sends_and_cleans_up(live, fake_tg, settings):
    fake_tg.files["F1"] = img_bytes("PNG", (60, 40))
    body = job_body(9, op="img.cv", params={"format": "webp"})
    assert signed(live, "POST", "/v1/jobs", body).status_code == 202
    jid = body["job_id"]
    job = wait_for(lambda: (j := signed(live, "GET", f"/v1/jobs/{jid}?user_id=7").json()["job"])["status"]
                   in ("COMPLETED", "FAILED") and j)
    assert job["status"] == "COMPLETED", job
    [out] = job["outputs"]
    assert out["name"] == "photo.webp" and out["file_id"].startswith("out-") and out["type"] == "webp"
    methods = fake_tg.methods()
    assert methods[:2] == ["getFile", "editMessageText"]  # download, then "processing"
    assert "sendDocument" in methods and methods[-1] == "editMessageText"
    send = next(c for c in fake_tg.calls if c[0] == "sendDocument")
    assert send[2]["document"][0] == "photo.webp"
    assert json.loads(send[1]["reply_markup"])["inline_keyboard"][0][0]["callback_data"] == "wf:WC-000009"
    assert json.loads(send[1]["reply_parameters"])["message_id"] == 54
    final = fake_tg.calls[-1][1]
    assert final["message_id"] == "55" and "photo.webp" in final["text"] and "WC-000009" in final["text"]
    assert not any(settings.jobs_dir.iterdir()), "temp files left behind"
    forbidden = {"setWebhook", "deleteWebhook", "getUpdates"}
    assert not forbidden & set(methods)


def test_failures_edit_the_status_message_in_the_users_language(live, fake_tg):
    fake_tg.files["BAD"] = b"not an image at all"
    body = job_body(10, inputs=[{"file_id": "BAD", "name": "x.png", "type": "png", "size": 19}], lang="en")
    signed(live, "POST", "/v1/jobs", body)
    jid = body["job_id"]
    job = wait_for(lambda: (j := signed(live, "GET", f"/v1/jobs/{jid}?user_id=7").json()["job"])["status"] == "FAILED" and j)
    assert job["error_code"] == "IMAGE_DAMAGED"
    final = fake_tg.calls[-1]
    assert final[0] == "editMessageText" and "damaged" in final[1]["text"] and "WC-000010" in final[1]["text"]


def test_missing_telegram_file_is_reported(live, fake_tg):
    body = job_body(11, inputs=[{"file_id": "GONE", "name": "x.png", "type": "png", "size": 1}])
    signed(live, "POST", "/v1/jobs", body)
    jid = body["job_id"]
    job = wait_for(lambda: (j := signed(live, "GET", f"/v1/jobs/{jid}?user_id=7").json()["job"])["status"] == "FAILED" and j)
    assert job["error_code"] == "FILE_GONE"


def test_text_to_image_job_and_text_is_not_kept(live, fake_tg, settings):
    body = job_body(12, op="tti", inputs=[], params={"text": "متن خصوصی کاربر", "theme": "ocean"})
    assert signed(live, "POST", "/v1/jobs", body).status_code == 202
    jid = body["job_id"]
    job = wait_for(lambda: (j := signed(live, "GET", f"/v1/jobs/{jid}?user_id=7").json()["job"])["status"]
                   in ("COMPLETED", "FAILED") and j)
    assert job["status"] == "COMPLETED", job
    import sqlite3
    db = sqlite3.connect(settings.db_path)
    params = db.execute("SELECT params FROM jobs WHERE id = ?", (jid,)).fetchone()[0]
    assert "متن" not in params and "text" not in json.loads(params)


def test_restart_fails_interrupted_jobs_with_a_message(settings, fake_tg):
    from app.queue import JobQueue
    q = JobQueue(settings.db_path)
    q.submit({"id": "01JOBINTERRUPTED000000001", "code": "WC-RESTART", "user_id": 7, "chat_id": 7, "lang": "fa",
              "op": "img.gr", "queue": "light", "inputs": [], "params": {}, "status_message_id": 77})
    q.claim("light")
    q.close()
    app = create_app(settings, tg=fake_tg.client(), run_workers=False)
    with TestClient(app):
        wait_for(lambda: any(c[0] == "editMessageText" and c[1].get("message_id") == "77" for c in fake_tg.calls))
    edit = next(c for c in fake_tg.calls if c[1].get("message_id") == "77")
    assert "WC-RESTART" in edit[1]["text"]


def test_token_never_reaches_logs(live, fake_tg, capsys):
    fake_tg.files["F1"] = img_bytes("PNG", (10, 10))
    body = job_body(13)
    signed(live, "POST", "/v1/jobs", body)
    wait_for(lambda: signed(live, "GET", f"/v1/jobs/{body['job_id']}?user_id=7").json()["job"]["status"] == "COMPLETED")
    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err and SECRET not in out.out + out.err


def test_ocr_job_text_lands_in_the_status_message_with_docx_and_copy(live, fake_tg):
    import shutil
    if not shutil.which("tesseract"):
        pytest.skip("Tesseract is not installed")
    from tests.test_ocr import page, png
    fake_tg.files["SCAN"] = png(page("کتابخانه ملی ایران در سال ۱۳۱۶ تأسیس شد", 44, 1300))
    body = job_body(20, op="ocr", inputs=[{"file_id": "SCAN", "name": "scan.png", "type": "png", "size": 1}], params={})
    assert signed(live, "POST", "/v1/jobs", body).status_code == 202
    job = wait_for(lambda: (j := signed(live, "GET", f"/v1/jobs/{body['job_id']}?user_id=7").json()["job"])["status"]
                   in ("COMPLETED", "FAILED") and j, timeout=60)
    assert job["status"] == "COMPLETED", job
    final = fake_tg.calls[-1]
    assert final[0] == "editMessageText"
    text = final[1]["text"]
    assert "متن استخراج" in text and "Tesseract" in text and "\n\nکتابخانه" in text
    kb = json.loads(final[1]["reply_markup"])["inline_keyboard"]
    assert kb[0][0]["copy_text"]["text"].startswith("کتابخانه") and kb[1][0]["callback_data"] == "od:000020"
    assert job["outputs"] == []


def test_pdf_password_reaches_the_tool_and_is_scrubbed(live, fake_tg, settings):
    from tests.pdf_fixtures import encrypt, text_pdf
    fake_tg.files["LOCKED"] = encrypt(text_pdf())
    body = job_body(21, op="pdf.ul", inputs=[{"file_id": "LOCKED", "name": "a.pdf", "type": "pdf", "size": 1, "pages": 1}],
                    params={"password": "secret"})
    signed(live, "POST", "/v1/jobs", body)
    job = wait_for(lambda: (j := signed(live, "GET", f"/v1/jobs/{body['job_id']}?user_id=7").json()["job"])["status"]
                   in ("COMPLETED", "FAILED") and j, timeout=30)
    assert job["status"] == "COMPLETED" and job["outputs"][0]["name"] == "a_unlocked.pdf"
    import sqlite3
    params = sqlite3.connect(settings.db_path).execute("SELECT params FROM jobs WHERE id = ?", (body["job_id"],)).fetchone()[0]
    assert "secret" not in params


def test_timeout_grows_with_pages(settings, fake_tg, monkeypatch):
    from app import runner as R
    seen = {}

    def fake_run(spec, workdir, timeout, *a, **k):
        seen["timeout"] = timeout
        return {"outputs": [], "notes": ["compress_not_smaller"], "stats": {}}
    monkeypatch.setattr(R.sandbox, "run", fake_run)
    import structlog

    from app.queue import JobQueue
    from app.registry import load_operations
    q = JobQueue(settings.db_path)
    fake_tg.files["P"] = b"%PDF-1.7"
    r = R.Runner(settings, q, fake_tg.client(), load_operations(), structlog.get_logger())
    settings.jobs_dir.mkdir(parents=True, exist_ok=True)
    for pages, expected in ((1, 120 + 25), (20, 120 + 25 * 20), (100, 900)):
        job = {"id": f"01JOBTIMEOUT{pages:014d}", "code": "WC-TIMEOUT", "user_id": 7, "chat_id": 7, "lang": "fa", "op": "ocr",
               "queue": "heavy", "inputs": [{"file_id": "P", "name": "a.pdf", "type": "pdf", "size": 8, "pages": pages}],
               "params": {}, "status_message_id": None}
        q.submit(job)
        r.process(q.claim("heavy"))
        assert seen["timeout"] == expected, pages

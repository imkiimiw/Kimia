import time

import pytest

from app.queue import JobQueue, QueueError


def job(i, user=1, queue="light", **kw):
    return {"id": f"job-{i:06d}", "code": f"WC-{i:06d}", "user_id": user, "chat_id": user, "lang": "fa",
            "op": "img.gr", "queue": queue, "inputs": [], "params": {"text": "secret words"}, **kw}


@pytest.fixture
def q(tmp_path):
    return JobQueue(tmp_path / "q.sqlite", caps={"light": 2, "heavy": 1}, max_active_per_user=5)


def test_submit_is_idempotent_and_ids_cant_be_stolen(q):
    a, created = q.submit(job(1))
    b, again = q.submit(job(1))
    assert created and not again and a["id"] == b["id"]
    with pytest.raises(QueueError) as e:
        q.submit(job(1, user=2))
    assert e.value.code == "JOB_ID_CONFLICT"


def test_per_user_running_cap_and_fifo(q):
    for i in range(4):
        q.submit(job(i, user=1))
        time.sleep(0.001)
    q.submit(job(10, user=2))
    first = q.claim("light")
    second = q.claim("light")
    assert [first["id"], second["id"]] == ["job-000000", "job-000001"]
    third = q.claim("light")  # user 1 already runs 2 light jobs → user 2's job goes next
    assert third["id"] == "job-000010"
    assert q.claim("light") is None
    q.finish(first["id"], "COMPLETED", result={})
    assert q.claim("light")["id"] == "job-000002"


def test_heavy_cap_is_one(q):
    q.submit(job(1, queue="heavy"))
    q.submit(job(2, queue="heavy"))
    assert q.claim("heavy")["id"] == "job-000001"
    assert q.claim("heavy") is None
    assert q.claim("light") is None


def test_active_jobs_per_user_are_capped(q):
    for i in range(5):
        q.submit(job(i))
    with pytest.raises(QueueError) as e:
        q.submit(job(9))
    assert e.value.code == "USER_BUSY" and e.value.status == 429


def test_cancel_only_by_owner(q):
    q.submit(job(1))
    assert q.cancel("job-000001", user_id=2) is None
    assert q.cancel("job-000001", user_id=1)["status"] == "CANCELLED"
    q.submit(job(2))
    q.claim("light")
    r = q.cancel("job-000002", user_id=1)
    assert r["status"] == "DOWNLOADING" and r["cancel_requested"]
    assert not q.set_status("job-000002", "PROCESSING")  # the runner sees it and stops


def test_text_params_are_scrubbed_when_a_job_ends(q):
    q.submit(job(1))
    assert q.get("job-000001")["params"]["text"] == "secret words"
    q.claim("light")
    q.finish("job-000001", "COMPLETED", result={"outputs": []})
    assert "text" not in q.get("job-000001")["params"]


def test_recover_fails_interrupted_jobs_and_never_reruns_them(q):
    q.submit(job(1))
    q.submit(job(2))
    q.claim("light")
    rec = q.recover()
    assert [r["id"] for r in rec] == ["job-000001"]
    assert q.get("job-000001")["status"] == "FAILED" and q.get("job-000001")["error_code"] == "WORKER_RESTARTED"
    assert q.get("job-000002")["status"] == "QUEUED"


def test_expire_and_replay_cache(q):
    q.submit(job(1))
    assert q.expire(-1)[0]["status"] == "EXPIRED"
    assert q.seen("abc") and not q.seen("abc")


def test_claim_waits_for_new_work(q):
    import threading
    got = {}
    t = threading.Thread(target=lambda: got.setdefault("j", q.claim("light", wait_s=3)))
    t.start()
    time.sleep(0.2)
    q.submit(job(7))
    t.join(4)
    assert got["j"]["id"] == "job-000007"

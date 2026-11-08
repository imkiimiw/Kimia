"""Durable job queue on SQLite (spec §8): `light` and `heavy` queues, idempotent by job id, a per-user
concurrency cap per queue, crash recovery, and the replay cache for request signatures.
One process owns the file (uvicorn --workers 1); a lock serializes access from the runner threads."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

ACTIVE = ("QUEUED", "DOWNLOADING", "PROCESSING", "UPLOADING")
RUNNING = ("DOWNLOADING", "PROCESSING", "UPLOADING")
FINAL = ("COMPLETED", "FAILED", "CANCELLED", "EXPIRED")

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  op TEXT NOT NULL,
  queue TEXT NOT NULL,
  status TEXT NOT NULL,
  inputs TEXT NOT NULL,
  params TEXT NOT NULL,
  status_message_id INTEGER,
  reply_to INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_vars TEXT,
  result TEXT,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (queue, status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS seen_signatures (sig TEXT PRIMARY KEY, at REAL NOT NULL);
"""


class QueueError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in ("inputs", "params", "error_vars", "result"):
        if d.get(k):
            d[k] = json.loads(d[k])
    d["cancel_requested"] = bool(d["cancel_requested"])
    return d


class JobQueue:
    def __init__(self, path: Path | str, caps: dict[str, int] | None = None, max_active_per_user: int = 5,
                 max_queued: int = 200):
        self.caps = caps or {"light": 2, "heavy": 1}
        self.max_active_per_user = max_active_per_user
        self.max_queued = max_queued
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(SCHEMA)

    # ---- submission -------------------------------------------------------------------------
    def submit(self, job: dict) -> tuple[dict, bool]:
        """Insert a job; the same id again returns the stored job (idempotency). → (job, created)."""
        now = time.time()
        with self._lock:
            old = _row(self._db.execute("SELECT * FROM jobs WHERE id = ?", (job["id"],)).fetchone())
            if old:
                if old["user_id"] != job["user_id"]:
                    raise QueueError("JOB_ID_CONFLICT", 409)
                return old, False
            active = self._db.execute(
                f"SELECT count(*) FROM jobs WHERE user_id = ? AND status IN ({','.join('?' * len(ACTIVE))})",
                (job["user_id"], *ACTIVE)).fetchone()[0]
            if active >= self.max_active_per_user:
                raise QueueError("USER_BUSY", 429)
            queued = self._db.execute("SELECT count(*) FROM jobs WHERE status = 'QUEUED'").fetchone()[0]
            if queued >= self.max_queued:
                raise QueueError("QUEUE_FULL", 503)
            self._db.execute(
                "INSERT INTO jobs (id, code, user_id, chat_id, lang, op, queue, status, inputs, params,"
                " status_message_id, reply_to, created_at) VALUES (?,?,?,?,?,?,?,'QUEUED',?,?,?,?,?)",
                (job["id"], job["code"], job["user_id"], job["chat_id"], job["lang"], job["op"], job["queue"],
                 json.dumps(job["inputs"]), json.dumps(job["params"]), job.get("status_message_id"),
                 job.get("reply_to"), now))
            self._wake.notify_all()
            return _row(self._db.execute("SELECT * FROM jobs WHERE id = ?", (job["id"],)).fetchone()), True

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            return _row(self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def position(self, job: dict) -> int:
        """1-based place in its queue (0 when not queued)."""
        if job["status"] != "QUEUED":
            return 0
        with self._lock:
            return self._db.execute(
                "SELECT count(*) FROM jobs WHERE queue = ? AND status = 'QUEUED' AND created_at <= ?",
                (job["queue"], job["created_at"])).fetchone()[0]

    # ---- the runner side -----------------------------------------------------------------------
    def claim(self, queue: str, wait_s: float = 0.0) -> dict | None:
        """Atomically move the oldest runnable job to DOWNLOADING. A job is runnable when its user has
        fewer than caps[queue] running jobs in that queue."""
        deadline = time.monotonic() + wait_s
        with self._lock:
            while True:
                r = self._db.execute(
                    "UPDATE jobs SET status = 'DOWNLOADING', started_at = ?, attempts = attempts + 1"
                    " WHERE id = (SELECT j.id FROM jobs j WHERE j.queue = ? AND j.status = 'QUEUED'"
                    "   AND (SELECT count(*) FROM jobs r WHERE r.user_id = j.user_id AND r.queue = j.queue"
                    "        AND r.status IN ('DOWNLOADING','PROCESSING','UPLOADING')) < ?"
                    "   ORDER BY j.created_at LIMIT 1)"
                    " RETURNING *", (time.time(), queue, self.caps.get(queue, 1))).fetchall()
                if r:  # fetchall: the statement must finish before the autocommit is complete
                    return _row(r[0])
                left = deadline - time.monotonic()
                if left <= 0:
                    return None
                self._wake.wait(left)

    def set_status(self, job_id: str, status: str) -> bool:
        """Advance a running job; False when it was cancelled meanwhile."""
        with self._lock:
            cur = self._db.execute(
                f"UPDATE jobs SET status = ? WHERE id = ? AND status IN ({','.join('?' * len(RUNNING))})"
                " AND cancel_requested = 0", (status, job_id, *RUNNING))
            return cur.rowcount == 1

    def finish(self, job_id: str, status: str, result: dict | None = None, error_code: str | None = None,
               error_vars: dict | None = None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE jobs SET status = ?, result = ?, error_code = ?, error_vars = ?, finished_at = ?,"
                " params = json_remove(params, '$.text')"  # user text is never kept after the job
                f" WHERE id = ? AND status NOT IN ({','.join('?' * len(FINAL))})",
                (status, json.dumps(result) if result is not None else None, error_code,
                 json.dumps(error_vars) if error_vars else None, time.time(), job_id, *FINAL))
            self._wake.notify_all()

    def cancel(self, job_id: str, user_id: int) -> dict | None:
        """Queued → CANCELLED now; running → cancel_requested (the runner kills the child). None if the
        job doesn't exist or isn't the user's (indistinguishable on purpose)."""
        with self._lock:
            job = _row(self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())
            if not job or job["user_id"] != user_id:
                return None
            if job["status"] == "QUEUED":
                self._db.execute("UPDATE jobs SET status = 'CANCELLED', finished_at = ?,"
                                 " params = json_remove(params, '$.text') WHERE id = ? AND status = 'QUEUED'",
                                 (time.time(), job_id))
            elif job["status"] in RUNNING:
                self._db.execute("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", (job_id,))
            return _row(self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def cancel_requested(self, job_id: str) -> bool:
        with self._lock:
            r = self._db.execute("SELECT cancel_requested FROM jobs WHERE id = ?", (job_id,)).fetchone()
            return bool(r and r[0])

    def recover(self) -> list[dict]:
        """After a crash/restart: jobs caught mid-run fail with WORKER_RESTARTED (their status message is
        edited by the caller). Re-running could send a result twice, so they're never retried silently."""
        with self._lock:
            rows = self._db.execute(
                "UPDATE jobs SET status = 'FAILED', error_code = 'WORKER_RESTARTED', finished_at = ?,"
                " params = json_remove(params, '$.text')"
                f" WHERE status IN ({','.join('?' * len(RUNNING))}) RETURNING *", (time.time(), *RUNNING)).fetchall()
            return [_row(r) for r in rows]

    def expire(self, older_than_s: float) -> list[dict]:
        """Queued too long (the worker was overloaded or down): EXPIRED, never run late."""
        with self._lock:
            rows = self._db.execute(
                "UPDATE jobs SET status = 'EXPIRED', finished_at = ?, params = json_remove(params, '$.text')"
                " WHERE status = 'QUEUED' AND created_at < ? RETURNING *",
                (time.time(), time.time() - older_than_s)).fetchall()
            return [_row(r) for r in rows]

    def stats(self) -> dict:
        with self._lock:
            rows = self._db.execute(
                f"SELECT queue, status, count(*) n FROM jobs WHERE status IN ({','.join('?' * len(ACTIVE))})"
                " GROUP BY queue, status", ACTIVE).fetchall()
            out: dict = {"light": {}, "heavy": {}}
            for r in rows:
                out.setdefault(r["queue"], {})[r["status"]] = r["n"]
            return out

    def prune(self, keep_s: float = 86400) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?",
                                   (time.time() - keep_s,))
            self._db.execute("DELETE FROM seen_signatures WHERE at < ?", (time.time() - 900,))
            return cur.rowcount

    # ---- replay cache ------------------------------------------------------------------------------
    def seen(self, nonce: str) -> bool:
        """Record a request nonce; True when it wasn't seen before (kept 15 min > the ±5 min window)."""
        with self._lock:
            cur = self._db.execute("INSERT OR IGNORE INTO seen_signatures (sig, at) VALUES (?, ?)", (nonce, time.time()))
            return cur.rowcount == 1

    def close(self) -> None:
        with self._lock:
            self._db.close()

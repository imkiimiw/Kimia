"""Worker HTTP API (spec §2, §8). Every /v1 request is HMAC-signed by the bot (security.py).

GET    /healthz                       liveness (no auth, no details)
GET    /readyz                        readiness: queue open, temp dir writable, operations loaded
GET    /v1/capabilities               operations and formats this worker can do right now
GET    /v1/health                     queue sizes, features, uptime, disk
POST   /v1/jobs                       submit (idempotent by job id)
GET    /v1/jobs/{id}?user_id=         a job, only to its owner
DELETE /v1/jobs/{id}?user_id=         cancel, only by its owner
"""
from __future__ import annotations

import os
import re
import shutil
import threading
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import config, logs
from .config import VERSION, Settings
from .queue import JobQueue, QueueError
from .registry import available, capabilities, load_operations, self_test
from .runner import Runner
from .security import AuthError, verify
from .telegram import Telegram

MAX_BODY = 64 * 1024
JOB_ID = r"^[A-Za-z0-9_-]{8,64}$"


class InputIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file_id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=255)
    type: str = Field(min_length=1, max_length=16, pattern=r"^[a-z0-9_]+$")
    size: int = Field(0, ge=0)


class JobIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str = Field(pattern=JOB_ID)
    code: str = Field(pattern=r"^[A-Z0-9-]{4,16}$")
    user_id: int = Field(gt=0)
    chat_id: int
    lang: str = Field("fa", pattern=r"^(fa|en)$")
    op: str = Field(min_length=1, max_length=16)
    inputs: list[InputIn] = Field(default_factory=list, max_length=20)
    params: dict = Field(default_factory=dict)
    status_message_id: int | None = None
    reply_to: int | None = None


def err(code: str, status: int, **extra) -> JSONResponse:
    return JSONResponse({"error": code, **extra}, status_code=status)


def public(job: dict, position: int = 0) -> dict:
    result = job.get("result") or {}
    return {
        "id": job["id"], "code": job["code"], "op": job["op"], "status": job["status"], "queue": job["queue"],
        "position": position, "cancel_requested": job["cancel_requested"],
        "error_code": job.get("error_code"), "error_vars": job.get("error_vars"),
        "outputs": result.get("outputs", []), "notes": result.get("notes", []),
        "input_bytes": result.get("input_bytes"), "output_bytes": result.get("output_bytes"), "ms": result.get("ms"),
        "created_at": job["created_at"], "started_at": job.get("started_at"), "finished_at": job.get("finished_at"),
    }


class _RateLimit:
    def __init__(self, per_min: int):
        self.per_min = per_min
        self.window = 0
        self.count = 0
        self.lock = threading.Lock()

    def allow(self) -> bool:
        with self.lock:
            w = int(time.time() // 60)
            if w != self.window:
                self.window, self.count = w, 0
            self.count += 1
            return self.count <= self.per_min


def create_app(settings: Settings | None = None, tg: Telegram | None = None, run_workers: bool = True,
               extra_processors: tuple[str, ...] = ()) -> FastAPI:
    settings = settings or config.load()
    logs.setup(os.environ.get("LOG_LEVEL", "INFO"))
    logs.add_secret(settings.bot_token)
    logs.add_secret(settings.worker_secret)
    log = logs.get()
    st = SimpleNamespace(ready=False)
    limiter = _RateLimit(settings.api_rate_per_min)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.jobs_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(settings.jobs_dir, 0o700)
        st.queue = JobQueue(settings.db_path, caps={"light": settings.max_light_per_user,
                                                    "heavy": settings.max_heavy_per_user})
        st.ops = load_operations(extra_processors)
        st.features = self_test()
        st.available = available(st.ops, st.features)
        st.caps = capabilities(st.ops, st.features, settings.limits())
        st.tg = tg or Telegram(settings.bot_token, settings.telegram_api)
        st.runner = Runner(settings, st.queue, st.tg, st.ops, log, extra_processors)
        recovered = st.queue.recover()
        if recovered:
            threading.Thread(target=st.runner.notify_restarted, args=(recovered,), daemon=True).start()
        if run_workers:
            st.runner.start()
        st.ready = True
        log.info("worker_started", version=VERSION, features=st.features, ops=sorted(st.available),
                 recovered=len(recovered))
        yield
        st.ready = False
        st.runner.stop()
        st.queue.close()

    app = FastAPI(title="Wanger Converter worker", version=VERSION, lifespan=lifespan, docs_url=None,
                  redoc_url=None, openapi_url=None)
    app.state.st = st

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if not request.url.path.startswith("/v1/"):
            return await call_next(request)
        if not limiter.allow():
            return err("RATE_LIMITED", 429)
        declared = request.headers.get("content-length")
        if declared and (not declared.isdigit() or int(declared) > MAX_BODY):
            return err("BODY_TOO_LARGE", 413)
        body = await request.body()
        if len(body) > MAX_BODY:
            return err("BODY_TOO_LARGE", 413)
        raw_path = request.scope.get("raw_path") or request.url.path.encode()
        path = raw_path.decode("latin-1")
        if request.scope.get("query_string"):
            path += "?" + request.scope["query_string"].decode("latin-1")
        try:
            verify(settings.worker_secret, request.headers.get("x-wanger-timestamp"),
                   request.headers.get("x-wanger-nonce"), request.headers.get("x-wanger-signature"),
                   request.method, path, body, st.queue.seen)
        except AuthError as e:
            log.warning("auth_failed", reason=e.code, path=request.url.path)
            return err(e.code, 401)
        return await call_next(request)

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    @app.get("/readyz")
    async def readyz():
        ok = st.ready and os.access(settings.jobs_dir, os.W_OK) and bool(getattr(st, "available", None))
        return JSONResponse({"ok": bool(ok)}, status_code=200 if ok else 503)

    @app.get("/v1/capabilities")
    async def caps():
        return st.caps

    @app.get("/v1/health")
    async def health():
        disk = shutil.disk_usage(settings.tmp_dir if settings.tmp_dir.exists() else "/")
        return {"version": VERSION, "uptime_s": int(time.time() - st.runner.started_at), "queues": st.queue.stats(),
                "features": st.features, "disk_free_mb": disk.free // (1024 * 1024)}

    @app.post("/v1/jobs")
    async def submit(request: Request):
        try:
            job = JobIn.model_validate_json(await request.body())
        except ValidationError as e:
            return err("BAD_REQUEST", 400, fields=[".".join(str(x) for x in d["loc"]) for d in e.errors()][:10])
        op = st.available.get(job.op)
        if op is None:
            return err("UNKNOWN_OP", 400)
        if not op.min_inputs <= len(job.inputs) <= op.max_inputs:
            return err("BAD_INPUTS", 400, min=op.min_inputs, max=op.max_inputs)
        for inp in job.inputs:
            if inp.type not in op.inputs:
                return err("BAD_INPUT_TYPE", 400, type=inp.type)
            if inp.size > settings.max_input_mb * 1024 * 1024:
                return err("TOO_BIG", 400, mb=settings.max_input_mb)
        try:
            params = op.params.model_validate(job.params).model_dump()
        except ValidationError as e:
            return err("BAD_PARAMS", 400, fields=[".".join(str(x) for x in d["loc"]) for d in e.errors()][:10])
        try:
            row, created = st.queue.submit({
                "id": job.job_id, "code": job.code, "user_id": job.user_id, "chat_id": job.chat_id,
                "lang": job.lang, "op": job.op, "queue": op.queue, "inputs": [i.model_dump() for i in job.inputs],
                "params": params, "status_message_id": job.status_message_id, "reply_to": job.reply_to})
        except QueueError as e:
            return err(e.code, e.status)
        if created:
            log.info("job_event", status="QUEUED", job=job.job_id, code=job.code, op=job.op, user=job.user_id)
        return JSONResponse({"job": public(row, st.queue.position(row))}, status_code=202 if created else 200)

    def _owned(job_id: str, user_id: str | None) -> dict | None:
        if not re.fullmatch(JOB_ID, job_id) or not user_id or not user_id.isdigit():
            return None
        job = st.queue.get(job_id)
        return job if job and job["user_id"] == int(user_id) else None

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request):
        job = _owned(job_id, request.query_params.get("user_id"))
        if not job:
            return err("NOT_FOUND", 404)
        return {"job": public(job, st.queue.position(job))}

    @app.delete("/v1/jobs/{job_id}")
    async def cancel_job(job_id: str, request: Request):
        uid = request.query_params.get("user_id")
        if not _owned(job_id, uid):
            return err("NOT_FOUND", 404)
        job = st.queue.cancel(job_id, int(uid))
        return {"job": public(job)}

    return app


def app_factory() -> FastAPI:  # uvicorn --factory app.main:app_factory
    return create_app()

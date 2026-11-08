"""Job runner threads: claim → download inputs → sandboxed processing → validate → send → edit the
status message → record the result. Plus a janitor (expired jobs, stale temp dirs, old rows)."""
from __future__ import annotations

import html
import shutil
import threading
import time
from pathlib import Path

from . import i18n, sandbox
from .processors.imageio import FORMATS
from .queue import JobQueue
from .sandbox import SandboxError
from .telegram import Telegram, TelegramError

MB = 1024 * 1024
EXT = {t: v[2] for v in FORMATS.values() for t in [v[4]]}
QUEUE_MAX_AGE_S = 30 * 60
MAX_JOB_S = 900  # no job runs longer, whatever its page count
TEXT_IN_MESSAGE = 3500  # like the bot's Gemini OCR (lib/jobs.js)
COPY_MAX = 256
USER_ERRORS = {"TOO_BIG", "FILE_GONE", "USER_BLOCKED"}


class Runner:
    def __init__(self, settings, queue: JobQueue, tg: Telegram, ops: dict, log, extra_processors=()):
        self.s = settings
        self.queue = queue
        self.tg = tg
        self.ops = ops
        self.log = log
        self.extra = list(extra_processors)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.started_at = time.time()

    # ---- lifecycle ----------------------------------------------------------------------------------
    def start(self) -> None:
        plan = [("light", self.s.light_workers), ("heavy", self.s.heavy_workers)]
        for qname, n in plan:
            for i in range(max(0, n)):
                t = threading.Thread(target=self._loop, args=(qname,), name=f"{qname}-{i}", daemon=True)
                t.start()
                self._threads.append(t)
        j = threading.Thread(target=self._janitor, name="janitor", daemon=True)
        j.start()
        self._threads.append(j)

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout)

    def _loop(self, qname: str) -> None:
        while not self._stop.is_set():
            job = self.queue.claim(qname, wait_s=1.0)
            if job:
                self.process(job)

    def _janitor(self) -> None:
        while not self._stop.wait(60):
            try:
                self.housekeeping()
            except Exception as exc:  # noqa: BLE001
                self.log.error("janitor_failed", error=type(exc).__name__)

    def housekeeping(self) -> None:
        for job in self.queue.expire(QUEUE_MAX_AGE_S):
            self._final_text(job, i18n.t(job["lang"], "status.EXPIRED", code=job["code"]))
        self.queue.prune()
        cutoff = time.time() - self.s.temp_retention_min * 60
        if self.s.jobs_dir.exists():
            for d in self.s.jobs_dir.iterdir():
                try:
                    if d.stat().st_mtime < cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                except FileNotFoundError:
                    pass

    def notify_cancelled(self, job: dict) -> None:
        self._final_text(job, i18n.t(job["lang"], "status.CANCELLED", code=job["code"]))

    def notify_restarted(self, jobs: list[dict]) -> None:
        for job in jobs:
            self._final_text(job, i18n.error_text(job["lang"], "WORKER_RESTARTED", {}, job["code"]))

    # ---- one job ---------------------------------------------------------------------------------------
    def _status(self, job: dict, status: str) -> None:
        if not job.get("status_message_id"):
            return
        text = i18n.t(job["lang"], "job.progress", status=i18n.t(job["lang"], f"status.{status}"), code=job["code"])
        try:
            self.tg.edit_text(job["chat_id"], job["status_message_id"], text)
        except TelegramError:
            pass  # progress is best-effort

    def _final_text(self, job: dict, text: str, markup: dict | None = None) -> None:
        """Edit the status message; if it's gone, reply with a new one."""
        try:
            if job.get("status_message_id") and self.tg.edit_text(job["chat_id"], job["status_message_id"], text, markup):
                return
            self.tg.send_message(job["chat_id"], text, reply_to=job.get("reply_to"), reply_markup=markup)
        except TelegramError as e:
            self.log.warning("status_edit_failed", job=job["id"], error=e.code)

    def _cancelled(self, job_id: str) -> bool:
        return self.queue.cancel_requested(job_id)

    def process(self, job: dict) -> None:
        log = self.log.bind(job=job["id"], code=job["code"], op=job["op"])
        op = self.ops.get(job["op"])
        workdir = self.s.jobs_dir / job["id"]
        t0 = time.monotonic()
        try:
            workdir.mkdir(parents=True, mode=0o700)
            if op is None:
                raise SandboxError("INTERNAL", detail="unknown op")
            inputs = []
            in_bytes = 0
            for i, inp in enumerate(job["inputs"]):
                dest = workdir / f"in{i}.{EXT.get(inp['type'], 'bin')}"  # never the user's file name on disk
                in_bytes += self.tg.download(inp["file_id"], dest, self.s.max_input_mb * MB)
                inputs.append({"path": str(dest), "name": inp["name"], "type": inp["type"]})
                if self._cancelled(job["id"]):
                    raise SandboxError("CANCELLED")
            if not self.queue.set_status(job["id"], "PROCESSING"):
                raise SandboxError("CANCELLED")
            self._status(job, "PROCESSING")
            base = self.s.timeout_heavy_s if op.queue == "heavy" else self.s.timeout_light_s
            pages = sum(max(1, int(i.get("pages") or 1)) for i in job["inputs"]) or 1
            timeout = min(MAX_JOB_S, max(base, op.timeout_s) + op.timeout_per_page_s * pages)
            spec = {"op": job["op"], "params": job["params"], "inputs": inputs, "limits": self.s.limits(),
                    "extra_processors": self.extra}
            t1 = time.monotonic()
            result = sandbox.run(spec, workdir, timeout, self.s.memory_limit_mb, self.s.max_output_mb,
                                 should_cancel=lambda: self._cancelled(job["id"]))
            proc_ms = int((time.monotonic() - t1) * 1000)
            out_bytes = 0
            for o in result["outputs"]:
                size = Path(o["path"]).stat().st_size
                if size == 0:
                    raise SandboxError("OUTPUT_INVALID")
                if size > self.s.max_output_mb * MB:
                    raise SandboxError("OUTPUT_TOO_BIG", {"mb": self.s.max_output_mb})
                o["size"] = size
                out_bytes += size
            if not self.queue.set_status(job["id"], "UPLOADING"):
                raise SandboxError("CANCELLED")
            result["_dir"] = str(workdir)
            sent = self._deliver(job, result)
            ms = int((time.monotonic() - t0) * 1000)
            self.queue.finish(job["id"], "COMPLETED", result={
                "outputs": sent, "notes": result.get("notes", []), "stats": result.get("stats", {}),
                "ms": ms, "processing_ms": proc_ms, "input_bytes": in_bytes, "output_bytes": out_bytes})
            log.info("job_event", status="COMPLETED", ms=ms, processing_ms=proc_ms, input_bytes=in_bytes,
                     output_bytes=out_bytes, outputs=len(sent), user=job["user_id"])
        except SandboxError as e:
            if e.code == "CANCELLED":
                self.queue.finish(job["id"], "CANCELLED")
                self._final_text(job, i18n.t(job["lang"], "status.CANCELLED", code=job["code"]))
                log.info("job_event", status="CANCELLED")
            else:
                self._fail(job, e.code, e.vars)
                log.warning("job_event", status="FAILED", error=e.code, detail=e.detail[-1500:] if e.detail else None)
        except TelegramError as e:
            if e.code in USER_ERRORS:
                code = e.code
            elif e.method in ("getFile", "download"):
                code = "DOWNLOAD_FAILED"
            else:
                code = "UPLOAD_FAILED"
            self._fail(job, code, {}, notify=e.code != "USER_BLOCKED")
            log.warning("job_event", status="FAILED", error=code, telegram=e.code, method=e.method)
        except Exception as exc:  # noqa: BLE001
            self._fail(job, "INTERNAL", {})
            log.exception("job_event", status="FAILED", error="INTERNAL", exc=type(exc).__name__)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _fail(self, job: dict, code: str, vars_: dict, notify: bool = True) -> None:
        self.queue.finish(job["id"], "FAILED", error_code=code, error_vars=vars_ or None)
        if notify:
            self._final_text(job, i18n.error_text(job["lang"], code, vars_, job["code"]))

    def _notes(self, lang: str, notes: list[str]) -> str:
        return "\n".join(i18n.t(lang, f"note.{n}") for n in notes if f"note.{n}" in i18n.FA)

    def _deliver_text(self, job: dict, result: dict) -> list[dict]:
        """OCR text, formatted like the bot's Gemini results so its «📄 DOCX» button (od:…) and
        «📋 کپی متن» work the same: short → the status message turns into the text; long → a .txt."""
        lang, code = job["lang"], job["code"]
        text = result["text"]
        script = (result.get("stats") or {}).get("script", "fa")
        head = f'{i18n.t(lang, "ocr.head", script=i18n.t(lang, f"ocr.script_{script}"), code=code)} {i18n.t(lang, "ocr.engine")}'
        notes = self._notes(lang, result.get("notes", []))
        docx = {"text": i18n.t(lang, "ocr.docx"), "callback_data": f"od:{code[3:]}"}
        if len(text) <= TEXT_IN_MESSAGE:
            rows = []
            if len(text) <= COPY_MAX:
                rows.append([{"text": i18n.t(lang, "ocr.copy"), "copy_text": {"text": text}}])
            rows.append([docx])
            body = "\n".join(x for x in (head, notes) if x) + "\n\n" + html.escape(text, quote=False)
            self._final_text(job, body, {"inline_keyboard": rows})
            return []
        path = Path(result["_dir"]) / "ocr.txt"
        path.write_bytes(("\ufeff" + text).encode("utf-8"))
        name = f"ocr_{code}.txt"
        caption = "\n".join(x for x in (head, notes) if x)[:1000]
        msg = self.tg.send_document(job["chat_id"], path, name, "text/plain", caption=caption, reply_to=job.get("reply_to"),
                                    reply_markup={"inline_keyboard": [[docx]]})
        self._final_text(job, i18n.t(lang, "job.done", name=name, code=code))
        return [self._sent(msg, {"name": name, "mime": "text/plain", "type": "text", "size": path.stat().st_size})]

    def _deliver(self, job: dict, result: dict) -> list[dict]:
        lang, code = job["lang"], job["code"]
        if result.get("text"):
            return self._deliver_text(job, result)
        outputs = result.get("outputs", [])
        notes = self._notes(lang, result.get("notes", []))
        more = {"inline_keyboard": [[{"text": i18n.t(lang, "job.more"), "callback_data": f"wf:{code}"}]]}
        sent: list[dict] = []
        if not outputs:
            self._final_text(job, i18n.t(lang, "job.progress", status=notes or "✅", code=code))
            return sent
        if len(outputs) == 1:
            o = outputs[0]
            msg = self.tg.send_document(job["chat_id"], Path(o["path"]), o["name"], o["mime"], reply_to=job.get("reply_to"),
                                        reply_markup=more)
            sent.append(self._sent(msg, o))
            text = i18n.t(lang, "job.done", name=o["name"], code=code)
            self._final_text(job, f"{text}\n{notes}" if notes else text)
            return sent
        for i in range(0, len(outputs), 10):
            chunk = outputs[i:i + 10]
            if len(chunk) == 1:
                msgs = [self.tg.send_document(job["chat_id"], Path(chunk[0]["path"]), chunk[0]["name"], chunk[0]["mime"],
                                              reply_to=job.get("reply_to"))]
            else:
                msgs = self.tg.send_document_group(job["chat_id"], [(Path(o["path"]), o["name"], o["mime"]) for o in chunk],
                                                   reply_to=job.get("reply_to"))
            sent.extend(self._sent(m, o) for m, o in zip(msgs, chunk, strict=False))
        text = i18n.t(lang, "job.group_done", n=len(sent), code=code)
        self._final_text(job, f"{text}\n{notes}" if notes else text, more)
        return sent

    @staticmethod
    def _sent(msg: dict, o: dict) -> dict:
        doc = (msg or {}).get("document") or {}
        return {"file_id": doc.get("file_id"), "file_unique_id": doc.get("file_unique_id"), "name": o["name"],
                "mime": o["mime"], "type": o["type"], "size": doc.get("file_size") or o.get("size"),
                "message_id": (msg or {}).get("message_id")}

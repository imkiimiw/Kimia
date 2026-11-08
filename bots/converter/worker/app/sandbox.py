"""Runs one operation in a fresh child process (spec §8 sandbox):
- its own session/process group, killed as a group on timeout or cancel (grandchildren included);
- resource limits set by the child before it reads any input (address space, CPU seconds, file size,
  open files, no core dumps) — see sandbox_entry.py;
- a minimal environment (no BOT_TOKEN, no WORKER_SECRET), cwd and TMPDIR = the job's temp dir;
- talks to the parent only through files in that dir (job.json in, result.json out).
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .config import ROOT

ENTRY = ROOT / "app" / "sandbox_entry.py"
STDERR_MAX = 16_000


class SandboxError(Exception):
    def __init__(self, code: str, vars_: dict | None = None, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.vars = vars_ or {}
        self.detail = detail


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def run(spec: dict, workdir: Path, timeout_s: float, memory_mb: int, max_output_mb: int,
        should_cancel=lambda: False) -> dict:
    """Execute spec = {op, params, inputs: [{path,name,type}], limits, extra_processors?} → result dict
    {outputs: [{path,name,mime,type}], notes, stats}. Raises SandboxError(code)."""
    spec = {**spec, "rlimits": {"memory_mb": memory_mb, "cpu_s": int(timeout_s) + 2,
                                "fsize_mb": max_output_mb * 2 + 16, "nofile": 256}}
    (workdir / "job.json").write_text(json.dumps(spec), encoding="utf-8")
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(workdir), "TMPDIR": str(workdir),
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "OMP_NUM_THREADS": "1", "PYTHONHASHSEED": "0",
           "PYTHONDONTWRITEBYTECODE": "1"}
    err_path = workdir / "stderr.log"
    with open(err_path, "wb") as err:
        proc = subprocess.Popen([sys.executable, "-I", str(ENTRY), str(workdir)],
                                cwd=workdir, env=env, stdin=subprocess.DEVNULL, stdout=err, stderr=err,
                                start_new_session=True, close_fds=True)
        deadline = time.monotonic() + timeout_s
        try:
            while True:
                try:
                    proc.wait(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if should_cancel():
                    _kill_group(proc)
                    raise SandboxError("CANCELLED")
                if time.monotonic() > deadline:
                    _kill_group(proc)
                    raise SandboxError("TIMEOUT")
        finally:
            # a finished leader may have left grandchildren behind: the group goes too
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    stderr = err_path.read_bytes()[-STDERR_MAX:].decode("utf-8", "replace")
    result_path = workdir / "result.json"
    if not result_path.exists():
        rc = proc.returncode
        if rc is not None and rc < 0 and -rc in (signal.SIGXCPU, signal.SIGKILL):
            raise SandboxError("TIMEOUT", detail=stderr)
        raise SandboxError("INTERNAL", detail=f"exit {rc}: {stderr}")
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SandboxError("INTERNAL", detail=f"bad result.json: {exc}") from exc
    if result.get("error"):
        raise SandboxError(result["error"], result.get("vars") or {}, detail=result.get("detail", "") or stderr)
    # outputs must be regular files inside the job dir (no symlinks, no escapes)
    root = workdir.resolve()
    for o in result.get("outputs", []):
        p = Path(o["path"])
        if p.is_symlink() or not p.is_file():
            raise SandboxError("OUTPUT_INVALID", detail=f"missing output {p.name}")
        rp = p.resolve()
        if root not in rp.parents:
            raise SandboxError("OUTPUT_INVALID", detail="output outside the job dir")
        o["path"] = str(rp)
    return result

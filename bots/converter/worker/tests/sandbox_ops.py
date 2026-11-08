"""Test-only operations for the sandbox (loaded through Settings.extra_processors, never in production)."""
import os
import subprocess
import sys
import time
from pathlib import Path

from app.processors.base import Operation, Output, Params, Processor, Result


class P(Params):
    seconds: float = 30
    mb: int = 0


def sleep(inputs, p, workdir: Path, limits):
    time.sleep(p.seconds)
    return Result()


def fork(inputs, p, workdir: Path, limits):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    (workdir / "grandchild.pid").write_text(str(child.pid))
    time.sleep(p.seconds)
    return Result()


def mem(inputs, p, workdir: Path, limits):
    blob = bytearray(p.mb * 1024 * 1024)  # beyond RLIMIT_AS → MemoryError
    return Result(stats={"len": len(blob)})


def env(inputs, p, workdir: Path, limits):
    return Result(stats={"env": sorted(os.environ), "cwd": os.getcwd()})


def escape(inputs, p, workdir: Path, limits):
    link = workdir / "evil.txt"
    link.symlink_to("/etc/passwd")
    return Result(outputs=[Output(link, "evil.txt", "text/plain", "txt")])


def crash(inputs, p, workdir: Path, limits):
    raise RuntimeError("boom with a secret? no secrets reach here")


def burn(inputs, p, workdir: Path, limits):
    x = 0
    while True:  # CPU-bound: stopped by the wall-clock timeout or RLIMIT_CPU
        x += 1


ANY = frozenset({"png", "jpeg"})
PROCESSOR = Processor("testing", [
    Operation("t.sleep", inputs=ANY, params=P, fn=sleep, min_inputs=0),
    Operation("t.fork", inputs=ANY, params=P, fn=fork, min_inputs=0),
    Operation("t.mem", inputs=ANY, params=P, fn=mem, min_inputs=0),
    Operation("t.env", inputs=ANY, params=P, fn=env, min_inputs=0),
    Operation("t.esc", inputs=ANY, params=P, fn=escape, min_inputs=0),
    Operation("t.crash", inputs=ANY, params=P, fn=crash, min_inputs=0),
    Operation("t.burn", inputs=ANY, params=P, fn=burn, min_inputs=0),
])

import os
import struct
import time
import zlib

import pytest

from app import sandbox
from app.sandbox import SandboxError
from tests.conftest import LIMITS, img_bytes

EXTRA = ["tests.sandbox_ops"]


def run(tmp_path, op, params=None, inputs=(), timeout=10, memory_mb=1024, should_cancel=lambda: False, limits=None):
    wd = tmp_path / "job"
    wd.mkdir(exist_ok=True)
    spec = {"op": op, "params": params or {}, "inputs": list(inputs), "limits": limits or LIMITS,
            "extra_processors": EXTRA}
    return sandbox.run(spec, wd, timeout, memory_mb, 50, should_cancel), wd


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:  # a zombie isn't alive
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def test_timeout_kills_the_whole_process_group(tmp_path):
    t0 = time.monotonic()
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "t.fork", {"seconds": 30}, timeout=1.5)
    assert e.value.code == "TIMEOUT"
    assert time.monotonic() - t0 < 6
    pid = int((tmp_path / "job" / "grandchild.pid").read_text())
    time.sleep(0.3)
    assert not alive(pid), "the grandchild survived the kill"


def test_cpu_bound_job_is_stopped(tmp_path):
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "t.burn", timeout=1.5)
    assert e.value.code == "TIMEOUT"


def test_cancel_kills_a_running_job(tmp_path):
    t0 = time.monotonic()
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "t.sleep", {"seconds": 30}, should_cancel=lambda: time.monotonic() - t0 > 0.5)
    assert e.value.code == "CANCELLED"
    assert time.monotonic() - t0 < 5


def test_memory_limit_turns_into_a_friendly_error(tmp_path):
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "t.mem", {"mb": 3000}, memory_mb=512)
    assert e.value.code == "IMAGE_TOO_BIG"


def test_child_gets_a_minimal_environment_without_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123:secret")
    monkeypatch.setenv("WORKER_SECRET", "x" * 40)
    res, wd = run(tmp_path, "t.env")
    env = res["stats"]["env"]
    assert "BOT_TOKEN" not in env and "WORKER_SECRET" not in env
    assert res["stats"]["cwd"] == str(wd)


def test_outputs_escaping_the_job_dir_are_refused(tmp_path):
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "t.esc")
    assert e.value.code == "OUTPUT_INVALID"


def test_unexpected_exceptions_become_internal_without_details_for_users(tmp_path):
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "t.crash")
    assert e.value.code == "INTERNAL" and e.value.vars == {}
    assert "RuntimeError" in e.value.detail  # for the log only


def _png_header_only(w, h):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00" * 64)) + chunk(b"IEND", b"")


@pytest.mark.parametrize("name,data,code", [
    ("bomb.png", _png_header_only(40000, 40000), "IMAGE_TOO_BIG"),     # 1.6 GP claimed in 60 bytes
    ("wide.png", _png_header_only(13000, 10), "IMAGE_TOO_BIG"),         # side over MAX_SIDE
    ("noise.png", os.urandom(4096), "IMAGE_DAMAGED"),
    ("cut.jpg", img_bytes("JPEG", (400, 300))[:600], "IMAGE_DAMAGED"),  # truncated
    ("empty.png", b"", "IMAGE_DAMAGED"),
    ("zero.png", _png_header_only(0, 10), "IMAGE_DAMAGED"),
])
def test_malicious_and_broken_images(tmp_path, name, data, code):
    p = tmp_path / name
    p.write_bytes(data)
    with pytest.raises(SandboxError) as e:
        run(tmp_path, "img.gr", inputs=[{"path": str(p), "name": name, "type": "png"}])
    assert e.value.code == code


def test_a_real_operation_runs_in_the_sandbox(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(img_bytes("PNG", (50, 40)))
    res, wd = run(tmp_path, "img.gr", inputs=[{"path": str(p), "name": "photo.png", "type": "png"}])
    [o] = res["outputs"]
    assert o["name"] == "photo_gray.png" and o["type"] == "png" and o["path"].startswith(str(wd.resolve()))

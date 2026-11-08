"""The bot and the worker must agree: every preset the bot can send (tgcloud/lib/wtools.js) is valid
for the worker's params model, and request signatures are computed identically on both sides."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.registry import load_operations
from app.security import sign

WTOOLS = Path(__file__).resolve().parents[2] / "tgcloud" / "lib" / "wtools.js"
NODE = shutil.which("node")


@pytest.mark.skipif(not NODE or not WTOOLS.exists(), reason="node or the bot sources are not available")
def test_every_bot_preset_is_valid_for_the_worker():
    script = (f"import {{ PRESETS, THEMES, SIZES }} from '{WTOOLS.as_uri()}';"
              "console.log(JSON.stringify({ PRESETS, THEMES, SIZES }));")
    out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, check=True, timeout=30)
    data = json.loads(out.stdout)
    ops = load_operations()
    assert len(data["PRESETS"]) > 30
    for pid, entry in data["PRESETS"].items():
        op, params = entry[0], dict(entry[1])
        if len(entry) > 2 and entry[2]:
            params["text"] = "نمونه"
        assert op in ops, pid
        ops[op].params.model_validate(params)
    for theme in data["THEMES"]:
        for size in data["SIZES"]:
            ops["tti"].params.model_validate({"text": "x", "theme": theme, "preset": size})


def test_signature_vectors_shared_with_the_bot_tests():
    # the same vectors are asserted in tests/unit/c4.test.mjs (crypto.subtle)
    assert sign("s" * 40, 1700000000, "0123456789abcdef0123456789abcdef", "POST", "/v1/jobs",
                '{"op":"img.cv","text":"سلام"}'.encode()) == "2d78c1471b7ab05f80232cc460d0642340786c4bb53f90d38ee56985358261b5"
    assert sign("s" * 40, 1700000000, "nonce-for-get-000001", "GET", "/v1/jobs/01ABC?user_id=7", b"") == \
        "a6a3ea5665e70f48376940c5a3fa106cd3a2897686e27a9958c58b2188dad0d5"

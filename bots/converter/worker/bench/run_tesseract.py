"""Runs the Tesseract variants over bench/set → bench/results_tesseract.json (see docs/OCR_BENCHMARK.md)."""
import json
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.processors import tesseract as T  # noqa: E402
from bench.score import accuracy  # noqa: E402

SET = Path(__file__).resolve().parent / "set"
# best=a tessdata directory or None (the installed fast models); prep=prepare() options or None (raw).
# TESS_BEST / TESS_MIX: directories with tessdata_best fas+eng, and best fas/ara + fast eng.
import os  # noqa: E402

VARIANTS = {
    "fast_raw": dict(best=None, prep=None),
    "fast_prep": dict(best=None, prep=dict()),
    "fast_prep_threshold": dict(best=None, prep=dict(threshold=True)),
    "best_raw": dict(best=os.environ.get("TESS_BEST"), prep=None),
    "best_prep": dict(best=os.environ.get("TESS_BEST"), prep=dict()),
    "mix_prep": dict(best=os.environ.get("TESS_MIX"), prep=dict()),
}


def main(tmp: Path) -> None:
    truth = json.loads((SET / "truth.json").read_text(encoding="utf-8"))
    results = {}
    for vname, v in VARIANTS.items():
        if v["best"] is None and vname.startswith(("best", "mix")):
            continue
        rows = {}
        for name, gt in truth.items():
            langs = "eng" if name.startswith("en") else "fas+eng"
            src = SET / name
            path = src
            if v["prep"] is not None:
                path = tmp / f"{vname}_{Path(name).stem}.png"
                with Image.open(src) as im:
                    T.prepare(im.convert("RGB"), **v["prep"]).save(path)
            t0 = time.monotonic()
            T.TESSDATA_BEST = Path(v["best"]) if v["best"] else Path("/nonexistent")
            text = T.recognize(path, langs, timeout=120, best=bool(v["best"]))
            rows[name] = {"acc": round(accuracy(text, gt), 4), "s": round(time.monotonic() - t0, 2), "text": text}
        results[vname] = rows
        mean = sum(r["acc"] for r in rows.values()) / len(rows)
        print(f"{vname:15s} mean {mean:.3f}  time {sum(r['s'] for r in rows.values()):.1f}s")
    (Path(__file__).resolve().parent / "results_tesseract.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ocrbench")
    out.mkdir(parents=True, exist_ok=True)
    main(out)

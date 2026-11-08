"""The child side of sandbox.run: limit itself, run one operation, write result.json. Started with
`python -I` (no user site, no cwd on sys.path), so only the worker's own code is importable."""
import json
import resource
import sys
import traceback
import warnings
from pathlib import Path


def _limits(r: dict) -> None:
    mb = 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (r["memory_mb"] * mb, r["memory_mb"] * mb))
    resource.setrlimit(resource.RLIMIT_CPU, (r["cpu_s"], r["cpu_s"] + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (r["fsize_mb"] * mb, r["fsize_mb"] * mb))
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    n = min(r["nofile"], hard) if hard != resource.RLIM_INFINITY else r["nofile"]
    resource.setrlimit(resource.RLIMIT_NOFILE, (n, n))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main() -> None:
    workdir = Path(sys.argv[1])
    spec = json.loads((workdir / "job.json").read_text(encoding="utf-8"))
    _limits(spec["rlimits"])
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    out_path = workdir / "result.json"

    def write(obj):
        tmp = workdir / "result.json.tmp"
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        tmp.replace(out_path)

    try:
        from PIL import Image

        from app.processors.base import Input, ToolError
        from app.registry import load_operations

        Image.MAX_IMAGE_PIXELS = int(spec["limits"]["max_image_pixels"])
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        ops = load_operations(spec.get("extra_processors") or ())
        op = ops[spec["op"]]
        params = op.params.model_validate(spec["params"])
        inputs = [Input(Path(i["path"]), i["name"], i["type"]) for i in spec["inputs"]]
        result = op.fn(inputs, params, workdir, spec["limits"])
        write({"outputs": [{"path": str(o.path), "name": o.name, "mime": o.mime, "type": o.type}
                           for o in result.outputs], "notes": result.notes, "stats": result.stats, "text": result.text})
    except ToolError as e:  # noqa: F821 — imported above when it can be raised
        write({"error": e.code, "vars": e.vars})
    except MemoryError:
        write({"error": "IMAGE_TOO_BIG", "vars": {"mp": spec["limits"]["max_image_pixels"] // 1_000_000,
                                                   "side": spec["limits"]["max_side"]}})
    except Exception as e:  # noqa: BLE001
        from PIL import Image, UnidentifiedImageError
        if isinstance(e, (Image.DecompressionBombError, Image.DecompressionBombWarning)):
            write({"error": "IMAGE_TOO_BIG", "vars": {"mp": spec["limits"]["max_image_pixels"] // 1_000_000,
                                                       "side": spec["limits"]["max_side"]}})
        elif isinstance(e, (UnidentifiedImageError, SyntaxError, EOFError)) or "truncated" in str(e).lower():
            write({"error": "IMAGE_DAMAGED", "vars": {}})
        else:
            write({"error": "INTERNAL", "vars": {}, "detail": traceback.format_exc()[-4000:]})


if __name__ == "__main__":
    main()

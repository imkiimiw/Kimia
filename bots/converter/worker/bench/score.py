"""Character accuracy = 1 − edit distance / length of the truth, after the normalization written in
docs/OCR_BENCHMARK.md (NFKC, Arabic ي/ك → Persian ی/ک, ZWNJ dropped, whitespace collapsed)."""
import re
import unicodedata

Z = "\U0000200c"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).replace("ي", "ی").replace("ى", "ی").replace("ك", "ک").replace(Z, "")
    return re.sub(r"\s+", " ", s).strip()


def distance(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def accuracy(pred: str, truth: str) -> float:
    p, t = norm(pred), norm(truth)
    return max(0.0, 1 - distance(p, t) / max(1, len(t)))

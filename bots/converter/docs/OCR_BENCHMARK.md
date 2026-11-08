# OCR benchmark (C5, 2026-11-08)

Spec §7.1: "Report character accuracy per engine. No accuracy claims without numbers." These are the
numbers, how they were made, and what they don't cover.

## The set
`worker/bench/make_set.py` (seed 1405) → `worker/bench/set/` (24 images + `truth.json`, committed):

- **8 texts:**
  - 4 Persian, with ZWNJ, Persian digits and punctuation
  - 2 English (an invoice line, an amount)
  - 2 mixed Persian/English (product names, a tracking code, an e-mail address, a time)
- **Fonts:** Vazirmatn, Sahel and Samim (rotating).
- **3 conditions per text:**
  - `screen`: a clean screenshot, 30 px text.
  - `small`: 15 px text at screen resolution.
  - `photo`: rotated ±3°, uneven lighting, blur, noise, JPEG quality 62.

**Metric:** character accuracy = 1 − edit distance / length of the truth. It is computed after
normalization (`worker/bench/score.py`):
- NFKC
- Arabic ي/ى/ك → Persian ی/ک
- ZWNJ dropped
- whitespace collapsed

## Results

| Engine | Images | Mean | screen | small | photo | Persian | English | mixed | Time / image |
|---|---|---|---|---|---|---|---|---|---|
| **Gemini `gemini-3.6-flash`** (in the bot) | 19 of 24¹ | **1.000** | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 2.7 s |
| **Gemini `gemini-3.5-flash-lite`** (fallback model) | 8² | **1.000** | — | — | — | — | — | — | — |
| **Tesseract 5, fast models + preprocessing** (shipped default) | 24 | **0.962** | 0.967 | 0.978 | 0.940 | 0.980 | 1.000 | 0.887 | 0.2 s |
| Tesseract, fast models, raw image | 24 | 0.887 | 0.961 | 0.818 | 0.881 | 0.927 | 1.000 | 0.692 | 0.2 s |
| Tesseract, fast + preprocessing + adaptive threshold | 24 | 0.874 | 0.945 | 0.869 | 0.807 | 0.831 | 0.974 | 0.857 | 0.2 s |
| Tesseract, `tessdata_best` + preprocessing | 24 | 0.970 | 0.975 | 0.971 | 0.965 | 0.975 | 1.000 | 0.932 | 0.4 s |
| Tesseract, best fas/ara + fast eng + preprocessing | 24 | 0.960 | 0.958 | 0.955 | 0.967 | 0.963 | 1.000 | 0.913 | 0.2 s |

¹ The other 5 requests hit Google's **free-tier quota of 20 requests per day for gemini-3.6-flash**
(429, `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, quotaValue 20). They were not counted as
zeros. Every one of the 19 answered images was exact after normalization.
² 8 of the 24: fa1 screen, fa2/fa4/mx1/mx2 small, fa3/mx2/en2 photo. This includes the 5 images that
got no answer from gemini-3.6-flash. All 8 were exact.

**Short single lines** (extra images that are not in the set) behaved differently, which decided the
model choice:

| Line | Tesseract fast | Tesseract best |
|---|---|---|
| «سلام دنیا، آزمایش ۱۴۰۵» | 0.95 | 0.68 |
| «کتابخانه ملی ایران …» | 0.97 | 0.87 |

With `best`, the English model misread Persian words as Latin («دنیا» → "Lod").

**A dense A4 page at 300 dpi** (12 Persian lines): fast models 1.2 s, best models 3.4 s.

## What was decided from these numbers

- **The AI is clearly better.** 1.000 against Tesseract's 0.962, and the gap is largest on mixed text
  (0.887). The bot's automatic mode therefore uses Gemini first and Tesseract when Gemini can't take
  the file, or when its quota is used up.
- **Tesseract preprocessing that is kept** (measured gain from 0.887 to 0.962):
  - **Upscale small text only.** Lines under 20 px tall are enlarged; upscaling 22–30 px lines lost
    accuracy.
  - **Deskew.** It takes the angle with the most uneven row profile and fills with the page's own
    colour; a white fill had cost photos 0.27.
  - **Crop to the text.** Tesseract's layout analysis split a lone Persian line in a wide page into
    nonsense.
  - **`--psm 7` for single-line images.**
- **Preprocessing that is dropped:** adaptive threshold lowered accuracy (0.874). Tesseract binarizes
  better itself.
- **Shipped models: the fast ones.** `tessdata_best` was +0.8 points on average, but worse on short
  lines and 2–3× slower. It stays optional (`TESSDATA_BEST_DIR`, used for PDFs up to 5 pages).
- **Gemini's free tier is about 20 OCRs per day per model** on this key. The bot therefore falls back
  from `gemini-3.6-flash` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`, each with its own quota,
  and then to Tesseract.

## What this does not show (limits of the benchmark)

- **Synthetic and small.** 24 images, rendered with three sans-serif fonts. Differences under about
  1 point are not meaningful.
- **Untested inputs:**
  - Naskh-style print fonts (B Nazanin, B Lotus — common in Persian books and letters; not free to ship)
  - real camera photos (perspective, glare, curved pages)
  - handwriting
  - low-resolution scans
  - Arabic, German, French, Spanish and Turkish text
- **Gemini's answers** depend on Google's current model behind the name. The numbers are from
  2026-11-08.
- **Next step:** a set of real photos and scans from the owner's users (with permission) would make
  this a real benchmark.

## Reproduce
```bash
cd bots/converter/worker
python3 bench/make_set.py                 # rebuilds bench/set (Pillow + RAQM + the bundled fonts)
TESS_BEST=/path/to/tessdata_best TESS_MIX=/path/to/mix python3 bench/run_tesseract.py /tmp/ocrbench
# Gemini: the bot's own geminiOcr on Serverless with the stored key (a temporary endpoint, never deployed)
```
Raw outputs: `worker/bench/results_tesseract.json`, `results_gemini.json`, `results_gemini-3.5-flash-lite.json`.

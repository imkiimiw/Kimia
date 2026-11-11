# Third-party components

Every library, WASM build, model and font this project ships or loads. Before adding anything GPL,
AGPL or non-commercial: ask Kimi (brief §4). Checked 2026-11-11 (npm registry / Hugging Face model
cards / upstream repositories).

## Phase 0 (spike build only)

| Component | Version | Licence | Used for | Shipped how |
|---|---|---|---|---|
| React, React DOM | 19.3 | MIT | Mini App UI | bundled |
| webm-muxer | 5.1.4 | MIT | WebM muxing without alpha (spike comparison) | bundled, lazy chunk |
| @jsquash/webp (libwebp inside) | 1.5.0 | Apache-2.0 (libwebp: BSD-3-Clause) | static WebP encoding | bundled, lazy chunk + wasm |
| wasm-webp (libwebp 1.3.2 inside) | 0.1.0 | MIT (libwebp: BSD-3-Clause) | animated WebP (WebPAnimEncoder) | bundled, lazy chunk + wasm |
| onnxruntime-web | 1.31.1 | MIT | on-device segmentation | bundled, lazy chunk + 14.8 MB wasm |
| @ffmpeg/ffmpeg, @ffmpeg/util | 0.12.15 / 0.12.2 | MIT | spike comparison only | bundled wrapper (lazy) |
| **@ffmpeg/core** | 0.12.10 | **GPL-2.0-or-later** | **spike comparison only** | **never bundled**: loaded from jsDelivr only when the tester taps the ffmpeg row. Not part of any proposed production path. |
| Vazirmatn (@fontsource/vazirmatn) | 5.3.0 | OFL-1.1 | Persian text | bundled woff2 (Arabic subset, 700) |
| U²-Netp ONNX (`u2netp.onnx`, from the rembg release; weights by xuebinqin/U-2-Net) | — | Apache-2.0 (weights); rembg MIT | background removal | copied into the spike build by `scripts/spike-assets.mjs` (sha256 `309c8469…f4ddd8`) |
| MODNet ONNX (Xenova/modnet, `model_quantized.onnx`) | — | Apache-2.0 | background removal (people) | fetched from Hugging Face at run time (spike) |
| telegram-web-app.js | — | Telegram (official script) | Mini App API | loaded from telegram.org |

## Dev-only (not shipped)

Vite, @vitejs/plugin-react, TypeScript, oxlint (MIT); @tgcloud/cli; json5 (MIT); Playwright (Apache-2.0, preinstalled; local spike runner).

## Evaluated and excluded

| Component | Licence | Reason |
|---|---|---|
| @imgly/background-removal | AGPL-3.0 / commercial | copyleft over the whole app |
| BRIA RMBG-1.4 / 2.0 | non-commercial | the bot may earn money later |
| onnx-community/ISNet-ONNX | tagged AGPL-3.0 | copyleft (the original DIS weights are Apache-2.0) |
| BiRefNet_lite ONNX | MIT | fine licence, too large for phones (115 MB fp16) |
| mediabunny | MPL-2.0 | not needed; would need approval (file-level copyleft) |

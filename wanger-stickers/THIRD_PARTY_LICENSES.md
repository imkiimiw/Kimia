# Third-party components

Every library, WASM build, model and font this project ships or loads. Before adding anything GPL,
AGPL or non-commercial: ask Kimi (brief §4). Checked 2026-11-11, Phase 3 additions 2026-11-12 (npm registry / Hugging Face model
cards / upstream repositories).

## Phase 6 — Android app (`android/`, checked 2026-11-14 on Maven Central / Google Maven)

| Component | Version | Licence | Used for | Shipped how |
|---|---|---|---|---|
| Kotlin standard library | 2.2.21 | Apache-2.0 | app code | in the APK (R8-shrunk) |
| Android Gradle Plugin | 8.13.2 | Apache-2.0 | build | build only |
| Gradle wrapper | 8.14.7 | Apache-2.0 | build (`gradlew`, `gradle/wrapper/gradle-wrapper.jar`) | in git, not in the APK |
| JUnit | 4.13.2 | EPL-1.0 | tests | test only |
| Robolectric | 4.18 | MIT | tests (Android framework on the JVM) | test only |
| org.json | 20250107 | Public Domain | tests (Android ships its own) | test only |

WhatsApp's sticker sample app (github.com/WhatsApp/stickers, BSD-3-Clause): we follow its documented
contract (provider paths, column names, intent extras, limits) — no code copied. Its licence forbids
using WhatsApp's name to endorse a derived product: the app says "Add to WhatsApp" as a function and
states it isn't made by or affiliated with WhatsApp.

## Phase 3 (shipped in the Studio, each in a lazy chunk)

| Component | Version | Licence | Used for | Shipped how |
|---|---|---|---|---|
| gifenc | 1.0.3 | MIT | GIF encoding | bundled, lazy chunk |
| omggif | 1.0.10 | MIT | GIF decoding | bundled, lazy chunk |
| mp4-muxer | 5.2.2 | MIT | H.264 MP4 muxing | bundled, lazy chunk |
| lottie-web (`lottie_light_canvas` build, no expressions) | 5.13.0 | MIT | TGS (Lottie) rendering | bundled, lazy chunk |
| fflate | 0.8.3 | MIT | gunzip where `DecompressionStream` is missing | bundled, lazy chunk |
| wasm-webp (libwebp 1.3.2: WebPAnimEncoder) | 0.1.0 | MIT (libwebp BSD-3-Clause) | WhatsApp animated stickers, animated WebP files | lazy chunk + wasm |

Our own code covers the rest: the WebM muxer with alpha, the animated-WebP muxer, the ZIP writer /
reader, the screenshot splitter. Evaluated for the iOS VP9 fallback: webm-wasm (Apache-2.0) is
VP8-only (libvpx 1.7, `V_VP8`), so it can't make Telegram video stickers (D19).

## Phase 2 (shipped in the Studio)

| Component | Version | Licence | Used for | Shipped how |
|---|---|---|---|---|
| React, React DOM | 19.3 | MIT | Studio UI | bundled |
| onnxruntime-web | 1.31.1 | MIT | background removal | lazy chunk + 14.2 MiB wasm (self-hosted) |
| @jsquash/webp (libwebp) | 1.5.0 | Apache-2.0 (libwebp BSD-3-Clause) | WebP export | lazy chunk + wasm |
| U²-Netp ONNX (`u2netp-v1.onnx`) | — | Apache-2.0 weights (xuebinqin/U-2-Net); file from rembg (MIT) | general cut-out | `/assets/models/`, sha256 `309c8469…f4ddd8` |
| MODNet q8 ONNX (`modnet-q8-v1.onnx`, Xenova/modnet) | — | Apache-2.0 | person cut-out | `/assets/models/`, sha256 `92e49898…fee3a` |
| Vazirmatn | 5.3.0 | OFL-1.1 | text | woff2 (Arabic + Latin, 700) |
| Lalezar | 5.3.0 | OFL-1.1 | text | woff2 (Arabic + Latin, 400) |
| Inter | 5.3.0 | OFL-1.1 | text | woff2 (Latin, 800) |

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

Vite, @vitejs/plugin-react, TypeScript, oxlint (MIT); @tgcloud/cli; json5 (MIT); Playwright (Apache-2.0, preinstalled; local spike runner); jsQR 1.4.0 (Apache-2.0; decodes our QR codes in tests).

Phase 4 adds no shipped third-party code: the QR encoder (`tgcloud/lib/core/qr.js`, written after
Nayuki's reference design, MIT) and the PNG writer are our own.

## Evaluated and excluded

| Component | Licence | Reason |
|---|---|---|
| @imgly/background-removal | AGPL-3.0 / commercial | copyleft over the whole app |
| BRIA RMBG-1.4 / 2.0 | non-commercial | the bot may earn money later |
| onnx-community/ISNet-ONNX | tagged AGPL-3.0 | copyleft (the original DIS weights are Apache-2.0) |
| BiRefNet_lite ONNX | MIT | fine licence, too large for phones (115 MB fp16) |
| mediabunny | MPL-2.0 | not needed; would need approval (file-level copyleft) |

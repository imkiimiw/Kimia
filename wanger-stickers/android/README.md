# Wanger Stickers for Android (Phase 6)

A small companion app that adds the bot's WhatsApp packs to WhatsApp through **WhatsApp's official
sticker integration** (a read-only ContentProvider plus the `ENABLE_STICKER_PACK` intent). WhatsApp
can't open a ZIP itself; this app is the missing step.

```
@Wanger_Motionbot ──«📦 Get the ZIP»──▶ ZIP in Telegram ──"Open with"──▶ this app ──«Add to WhatsApp»──▶ WhatsApp
```

- **Input:** the bot's ZIP (`01.webp…`, `tray.png`, `pack.json` in WhatsApp's `contents.json` shape)
  or a `.wastickers` file. Opened from Telegram ("Open with" / "Share") or with the system file picker.
- **Checks before storing** every WhatsApp rule (3–30 stickers, 512×512 WebP, static ≤ 100 KB,
  animated ≤ 500 KB / ≤ 10 s / frames ≥ 8 ms, never mixed, tray PNG ≤ 50 KB, 1–3 emojis, identifier
  characters) and names the sticker that breaks one. The numbers mirror the bot's
  `tgcloud/lib/core/limits.js` (`tests/android.test.mjs` fails if they drift).
- **Keeps** up to 10 packs (WhatsApp's per-app limit) in app-private storage; a re-import of the same
  pack replaces it and bumps `image_data_version` so WhatsApp refreshes.
- **Adds** to WhatsApp, WhatsApp Business or both (a chooser when both lack it); shows "✓ In WhatsApp"
  from WhatsApp's own whitelist provider; shows WhatsApp's refusal reason if it rejects a pack.
- **No permissions at all** — no internet, no storage. Nothing leaves the phone except what WhatsApp
  reads from the provider. Backups are off (packs can be re-imported from the bot).
- Persian and English (follows the phone's language), RTL, light and dark, Android 6.0+ (API 23),
  targets Android 16 (API 36). No AndroidX, no third-party code in the APK besides the Kotlin
  standard library: the release APK is about 80 KB.

## Code

| File | What |
|---|---|
| `Limits.kt` | WhatsApp's numbers (sticker / tray / pack) and our ZIP-reading caps |
| `Media.kt` | WebP / PNG header readers (port of the bot's `inspect.js`) |
| `PackReader.kt` | ZIP / .wastickers → checked pack (`ImportException` codes → localized messages) |
| `PackStore.kt` | the packs on the phone: one hashed folder per pack, atomic swap on save |
| `StickerContentProvider.kt` | what WhatsApp reads: `metadata`, `metadata/<id>`, `stickers/<id>`, `stickers_asset/<id>/<file>` |
| `WhatsApp.kt` | installed apps, whitelist check, the add intent |
| `MainActivity.kt`, `PackActivity.kt`, `BaseActivity.kt` | the two screens, the shared add / delete flow |

The provider contract (paths, column names, the `com.whatsapp.sticker.READ` read permission, the
intent extras) follows WhatsApp's guide and sample app (github.com/WhatsApp/stickers, BSD licence);
the code here is our own.

## Build and test

Needs JDK 17+ and the Android SDK (platform 36, build-tools); `local.properties` with
`sdk.dir=…` or `ANDROID_HOME`.

```bash
cd android
./gradlew testDebugUnitTest      # 40 JVM + Robolectric tests (provider contract, import → add flow on API 24 and 36)
./gradlew lintDebug              # 0 issues
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk (test build, debuggable)
./gradlew assembleRelease        # R8-shrunk; signed when signing is configured (below)
```

- The tests read real packs exported by the bot (`app/src/test/resources/fixtures/`, written by
  `node --import ./tests/sdk/register.mjs scripts/android-fixtures.mjs` from `wanger-stickers/`:
  Chromium draws real WebP / PNG files and the bot's own endpoints export them). Rerun it when the
  export format changes; `npm test` tells you when.
- `ScreenshotTest` renders both screens (fa / en / dark) into `app/build/screenshots/`.
- Where Maven Central rate-limits (HTTP 429), add `-ProbolectricRepo=<mirror>` for Robolectric's
  Android jars and a Gradle init script that puts the mirror first; nothing in the project needs it.

## Release signing — Kimi's decision

An Android app must be signed, and **every update must be signed with the same key**: lose the key
and users must uninstall and reinstall (re-importing their packs from the bot). The key is a secret,
so it is never in git or in chat. Two ways:

1. **Google Play** (one-time $25 developer account, Kimi's): use *Play App Signing* — Google keeps
   the app key; we only hold an upload key that Google can reset. Then set `play_store_url` in
   `app/src/main/res/values/strings.xml` (WhatsApp shows it to people who receive a sticker).
2. **Direct APK through the bot** (free): create the key once on a computer you control:
   ```bash
   keytool -genkeypair -v -keystore wanger-release.jks -alias wanger -keyalg RSA -keysize 4096 -validity 10000
   ```
   keep `wanger-release.jks` and its passwords safe (two copies), and build with
   `android/keystore.properties` (gitignored):
   ```
   storeFile=wanger-release.jks
   storePassword=…
   keyAlias=wanger
   keyPassword=…
   ```
   or the same values in `WANGER_APK_STOREFILE`, `WANGER_APK_STOREPASSWORD`, `WANGER_APK_KEYALIAS`,
   `WANGER_APK_KEYPASSWORD`. Then `./gradlew assembleRelease`.

Bump `versionCode` / `versionName` in `app/build.gradle.kts` for every release.

## Handing it out through the bot

`/admin` → ⚙️ → «📱 برنامه‌ی اندروید» → «📤 فرستادن فایل APK» → send the APK as a file. From then on
the guide the bot sends after every WhatsApp ZIP has a «📱 برنامه‌ی اندروید» button that sends users
that file (by `file_id`, nothing re-uploaded); «🗑» removes it and the button disappears. The Studio's
"ZIP sent" screen points to the button too.

## iPhone

WhatsApp's iOS integration needs an iOS app (Apple developer account, $99/year — Kimi's decision);
nothing here covers iOS.

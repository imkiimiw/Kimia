// Phase 0 device spike page. Opened inside Telegram (Android, iOS, Desktop, Web) on a test
// deployment; runs the encoders and the segmentation model on THIS device and sends the numbers to
// the owner's chat. Not a user feature: it is replaced by the Studio in Phase 2.
import { useEffect, useState } from 'react';
import { capabilities } from './caps';
import { call, insideTelegram } from './tg';
import * as T from './tests';

type Status = 'idle' | 'running' | 'done' | 'error';
interface Row {
  key: string;
  label: string;
  run: (p: T.Preview, file: File | null) => Promise<T.Result>;
  heavy?: string;
}

const ROWS: Row[] = [
  { key: 'caps', label: 'Capabilities', run: () => capabilities() },
  { key: 'vp9WebCodecs', label: 'VP9 + alpha (WebCodecs)', run: (p) => T.vp9WebCodecs(p) },
  { key: 'vp9DualAlpha', label: 'VP9 + alpha (2 WebCodecs encoders + own muxer)', run: (p) => T.vp9DualAlpha(p) },
  { key: 'webpStatic', label: 'Static WebP (libwebp WASM)', run: (p) => T.webpStatic(p) },
  { key: 'webpAnimated', label: 'Animated WebP (libwebp + muxer)', run: (p) => T.webpAnimated(p) },
  { key: 'webpAnimLibwebp', label: 'Animated WebP (libwebp WebPAnimEncoder)', run: (p) => T.webpAnimLibwebp(p) },
  { key: 'persianText', label: 'Persian text on canvas', run: (p) => T.persianText(p) },
  { key: 'segU2netp', label: 'Background removal: U²-Netp (4.7 MB)', run: (p, f) => T.segmentation(p, 'u2netp', f) },
  { key: 'segModnet', label: 'Background removal: MODNet q8 (6.6 MB)', run: (p, f) => T.segmentation(p, 'modnet_q8', f), heavy: 'downloads 6.6 MB' },
  { key: 'ffmpeg', label: 'ffmpeg.wasm single-thread (GPL core, spike only)', run: (p) => T.ffmpegWasm(p), heavy: 'downloads ~31 MB' },
  { key: 'endpoint', label: 'Endpoint request/response sizes', run: () => T.endpointLimits() },
  { key: 'static', label: 'Static hosting: large files', run: () => T.staticHosting() },
];

export default function SpikeLab() {
  const [results, setResults] = useState<Record<string, T.Result>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [previews, setPreviews] = useState<{ label: string; url: string; type: string }[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState('');

  const preview: T.Preview = (label, blob) => setPreviews((p) => [...p, { label, url: URL.createObjectURL(blob), type: blob.type }]);

  async function runOne(r: Row) {
    setStatus((s) => ({ ...s, [r.key]: 'running' }));
    const t0 = performance.now();
    try {
      const res = await r.run(preview, file);
      setResults((x) => ({ ...x, [r.key]: { ...res, totalMs: Math.round(performance.now() - t0) } }));
      setStatus((s) => ({ ...s, [r.key]: 'done' }));
    } catch (e) {
      setResults((x) => ({ ...x, [r.key]: { error: String((e as Error)?.message ?? e), totalMs: Math.round(performance.now() - t0) } }));
      setStatus((s) => ({ ...s, [r.key]: 'error' }));
    }
  }

  async function runAll(includeHeavy: boolean) {
    for (const r of ROWS) if (includeHeavy || !r.heavy) await runOne(r);
  }

  const report = () => ({ spike: 'wanger-stickers phase 0', at: new Date().toISOString(), device: results.caps?.telegram ?? { platform: 'browser' }, results });

  async function send() {
    try {
      const r = await call<{ bytes: number }>('spike_report', { report: report() });
      setSent(`sent to your chat (${r.bytes} bytes)`);
    } catch (e) {
      setSent(`send failed: ${(e as Error).message}`);
    }
  }

  // exposed for the local headless run (scripts/spike-local.mjs); refreshed after every render
  useEffect(() => {
    (window as unknown as { __spike: unknown }).__spike = {
      runAll,
      report,
      keys: ROWS.map((r) => r.key),
      runKey: (k: string) => runOne(ROWS.find((r) => r.key === k)!),
    };
  });

  return (
    <main className="lab">
      <h1>Wanger Stickers · Phase 0 spike</h1>
      <p className="muted">Measures what this device can encode. Nothing leaves the device unless you tap “Send to my chat”.</p>
      <label className="pick">
        Optional photo for background removal: <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <div className="buttons">
        <button onClick={() => runAll(false)}>Run all (light)</button>
        <button onClick={() => runAll(true)}>Run all + heavy</button>
        {insideTelegram() && <button onClick={send}>Send to my chat</button>}
        <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(report(), null, 2))}>Copy JSON</button>
      </div>
      {sent && <p className="muted">{sent}</p>}
      <ul className="rows">
        {ROWS.map((r) => (
          <li key={r.key} data-status={status[r.key] ?? 'idle'}>
            <button onClick={() => runOne(r)} disabled={status[r.key] === 'running'}>
              {status[r.key] === 'running' ? '…' : 'Run'}
            </button>
            <span>
              {r.label}
              {r.heavy && <small> ({r.heavy})</small>}
            </span>
            {results[r.key] && <pre>{JSON.stringify(results[r.key], null, 1)}</pre>}
          </li>
        ))}
      </ul>
      <section className="previews">
        {previews.map((p) => (
          <figure key={p.url}>
            {p.type.startsWith('video') ? <video src={p.url} autoPlay loop muted playsInline /> : <img src={p.url} alt={p.label} />}
            <figcaption>{p.label}</figcaption>
          </figure>
        ))}
      </section>
    </main>
  );
}

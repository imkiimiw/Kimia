// Screenshot to pack and batch mode (Phase 3, brief §9). Both end in the same runner: a list of
// cut-outs → one set of settings (outline, precise background removal) → one destination
// (a Telegram pack or a WhatsApp static pack) → stickers exported and uploaded one by one, with
// progress. A failed sticker is counted and skipped, never retried silently.
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadImage, makeCanvas, ctx2d, type Canvas } from '../engine/image';
import { Mask } from '../engine/mask';
import { newDoc } from '../engine/render';
import { toTelegramStatic, toWhatsAppStatic, trayIcon } from '../engine/export';
import { findStickers, foregroundMask, type Box } from '../engine/anim/split';
import { tg, type Boot } from './api';
import { num, type makeT, type Lang } from './i18n';
import { TelegramChoice, defaultTgChoice, tgChoiceReady, saveTelegram, WhatsAppChoice, defaultWaChoice, waChoiceReady, saveWhatsApp, WaSaved, type TgChoice, type WaChoice } from './Targets';

type T = ReturnType<typeof makeT>;
type Platform = 'telegram' | 'whatsapp';
type Item = () => Promise<{ src: Canvas; mask: Mask | null }>;

export const BATCH_MAX = 30; // a WhatsApp pack's maximum; also keeps one session's uploads modest

interface Common {
  info: Boot;
  t: T;
  lang: Lang;
  onAgain: () => void;
  onError: (e: unknown) => void;
  platform0?: Platform;
}

/* ------------------------------------------------------------------ runner */

function Runner({ info, t, lang, items, onAgain, onError, platform0, aiKey = 'batch_remove_bg' }: Common & { items: Item[]; aiKey?: 'batch_remove_bg' | 'split_bg_ai' }) {
  const [platform, setPlatform] = useState<Platform>(platform0 && info.flags.whatsapp ? platform0 : 'telegram');
  const [outline, setOutline] = useState(true);
  const [ai, setAi] = useState(false);
  const [tgc, setTgc] = useState<TgChoice>(() => defaultTgChoice(info));
  const [wac, setWac] = useState<WaChoice>(() => defaultWaChoice(info, 'static'));
  const [prog, setProg] = useState<{ i: number; n: number } | null>(null);
  const [done, setDone] = useState<{ ok: number; failed: number; last: unknown } | null>(null);
  const n = items.length;
  const ready = platform === 'telegram' ? tgChoiceReady(tgc) && tgc.action !== 'send' : waChoiceReady(wac);

  const go = async () => {
    let ok = 0;
    let failed = 0;
    let last: unknown = null;
    let tgChoice = { ...tgc };
    let waChoice = { ...wac };
    for (let i = 0; i < n; i++) {
      setProg({ i: i + 1, n });
      try {
        const { src, mask } = await items[i]();
        let m = mask || new Mask(src.width, src.height);
        if (ai) {
          const { removeBackground } = await import('../engine/segment');
          m = await removeBackground(src, 'general');
        }
        const d = newDoc(src, m);
        d.outline.on = outline;
        if (platform === 'telegram') {
          const res = await toTelegramStatic(d);
          const r = await saveTelegram(info, res.bytes, 'telegram_static', res.format, tgChoice, undefined, i < n - 1);
          if (r.action === 'new' && r.packId) {
            tgChoice = { ...tgChoice, action: 'add', packId: r.packId };
          }
          last = r;
        } else {
          const res = await toWhatsAppStatic(d);
          const title = waChoice.packId === null ? waChoice.title.trim() : info.wa.find((x) => x.id === waChoice.packId)?.title || '';
          const r = await saveWhatsApp(info, res.bytes, 'static', waChoice, async () => (await trayIcon(res.canvas)).bytes);
          if (waChoice.packId === null && r.packId) waChoice = { ...waChoice, packId: r.packId };
          last = { r, title };
        }
        ok++;
      } catch (e) {
        failed++;
        // a quota or permission refusal stops the batch: the next sticker would fail the same way
        const code = (e as { parameters?: { code?: string } })?.parameters?.code || '';
        if (/quota|JOIN_REQUIRED|BANNED|MAINTENANCE|FEATURE_OFF|full|gone/i.test(code)) {
          failed += n - i - 1;
          if (!ok) onError(e);
          break;
        }
      }
    }
    tg().HapticFeedback?.notificationOccurred(failed ? 'warning' : 'success');
    setProg(null);
    setDone({ ok, failed, last });
  };

  if (prog) return <main className="studio center"><div className="spinner" /><p>{t('batch_progress', { i: num(lang, prog.i), n: num(lang, prog.n) })}</p></main>;
  if (done) {
    if (platform === 'whatsapp' && done.ok && done.last) {
      const l = done.last as { r: Parameters<typeof WaSaved>[0]['result']; title: string };
      return (
        <>
          {done.failed > 0 && <p className="note center">{t('batch_failed', { n: num(lang, done.failed) })}</p>}
          <WaSaved info={info} t={t} lang={lang} result={l.r} title={l.title} onAgain={onAgain} />
        </>
      );
    }
    const name = done.last ? (done.last as { name?: string }).name || null : null;
    return (
      <main className="studio center">
        <p className="big">{t('batch_done', { ok: num(lang, done.ok) })}</p>
        {done.failed > 0 && <p className="note">{t('batch_failed', { n: num(lang, done.failed) })}</p>}
        {name && <button className="primary" onClick={() => tg().openTelegramLink?.(`https://t.me/addstickers/${name}`)}>{t('open_pack')}</button>}
        <button onClick={onAgain}>{t('another')}</button>
        <button onClick={() => tg().close?.()}>{t('close')}</button>
      </main>
    );
  }
  return (
    <div className="export">
      {info.flags.whatsapp && (
        <div className="row">
          {(['telegram', 'whatsapp'] as Platform[]).map((p) => <button key={p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>{t(`platform_${p}` as const)}</button>)}
        </div>
      )}
      <label className="opt"><input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} />{t('batch_outline')}</label>
      <label className="opt"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />{t(aiKey)}</label>
      <h2>{t('target_pack')}</h2>
      {platform === 'telegram'
        ? <TelegramChoice info={info} t={t} lang={lang} value={tgc} onChange={setTgc} allowSend={false} />
        : <WhatsAppChoice info={info} t={t} lang={lang} kind="static" value={wac} onChange={setWac} />}
      <button className="primary" disabled={!n || !ready} onClick={() => void go()}>{t('batch_go', { n: num(lang, n) })}</button>
    </div>
  );
}

/* ------------------------------------------------------------------ batch mode */

export function BatchScreen(p: Common & { onBack: () => void }) {
  const { t, lang } = p;
  const [files, setFiles] = useState<File[]>([]);
  const items: Item[] = useMemo(() => files.map((f) => async () => ({ src: await loadImage(f, 1024), mask: null })), [files]);
  if (!files.length) {
    return (
      <main className="studio center">
        <h2>{t('batch_title')}</h2>
        <p className="hint">{t('batch_max', { n: num(lang, BATCH_MAX) })}</p>
        <label className="primary file">
          {t('pick_multi_btn')}
          <input type="file" accept="image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, BATCH_MAX))} />
        </label>
        <button onClick={p.onBack}>{t('back_home')}</button>
      </main>
    );
  }
  return (
    <main className="studio">
      <h2>{t('batch_title')}</h2>
      <p className="hint">{t('batch_count', { n: num(lang, files.length) })}</p>
      <Runner {...p} items={items} />
    </main>
  );
}

/* ------------------------------------------------------------------ screenshot to pack */

const VIEW = 320;

export function SplitScreen(p: Common & { onBack: () => void; blob?: Blob | null }) {
  const { t, lang } = p;
  const [img, setImg] = useState<{ canvas: Canvas; data: ImageData } | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [failed, setFailed] = useState(false);
  const view = useRef<HTMLCanvasElement | null>(null);

  const open = async (b: Blob) => {
    try {
      const canvas = await loadImage(b, 1600);
      const data = ctx2d(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      setImg({ canvas, data });
      setBoxes(findStickers(data.data, data.width, data.height));
      setOff(new Set());
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => {
    if (p.blob) void open(p.blob);
  }, [p.blob]);

  const k = img ? VIEW / Math.max(img.canvas.width, img.canvas.height) : 1;
  useEffect(() => {
    const el = view.current;
    if (!el || !img) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(img.canvas.width * k * dpr);
    el.height = Math.round(img.canvas.height * k * dpr);
    const x = el.getContext('2d')!;
    x.scale(k * dpr, k * dpr);
    x.drawImage(img.canvas as CanvasImageSource, 0, 0);
    boxes.forEach((b, i) => {
      const on = !off.has(i);
      x.lineWidth = 3 / k;
      x.strokeStyle = on ? '#2a7de1' : 'rgba(128,128,128,0.7)';
      x.setLineDash(on ? [] : [8 / k, 6 / k]);
      x.strokeRect(b.x, b.y, b.w, b.h);
      x.fillStyle = on ? '#2a7de1' : 'rgba(128,128,128,0.8)';
      const s = 26 / k;
      x.fillRect(b.x, b.y, s, s);
      x.fillStyle = '#fff';
      x.font = `bold ${16 / k}px system-ui`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(num(lang, i + 1), b.x + s / 2, b.y + s / 2);
    });
  }, [img, boxes, off, k, lang]);

  const toggle = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / k;
    const py = (e.clientY - r.top) / k;
    const i = boxes.findIndex((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    if (i < 0) return;
    const next = new Set(off);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setOff(next);
  };

  /** One crop: its pixels and a mask from the same foreground rule the finder used. */
  const items: Item[] = useMemo(() => {
    if (!img) return [];
    return boxes.filter((_, i) => !off.has(i)).map((b) => async () => {
      const src = makeCanvas(b.w, b.h);
      const sx = ctx2d(src, { willReadFrequently: true });
      sx.drawImage(img.canvas as CanvasImageSource, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      const rgba = sx.getImageData(0, 0, b.w, b.h).data;
      const fg = foregroundMask(rgba, b.w, b.h);
      const mask = new Mask(b.w, b.h, 0);
      for (let i = 0; i < fg.length; i++) mask.data[i] = fg[i] ? 255 : 0;
      mask.version++;
      return { src, mask };
    });
  }, [img, boxes, off]);

  if (failed) return <main className="studio center"><p className="note">{t('decode_failed')}</p><button onClick={p.onBack}>{t('back_home')}</button></main>;
  if (!img) {
    return (
      <main className="studio center">
        <h2>{t('pick_split_title')}</h2>
        <p className="hint">{t('pick_split_hint')}</p>
        <label className="primary file">
          {t('pick_btn')}
          <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); }} />
        </label>
        <button onClick={p.onBack}>{t('back_home')}</button>
      </main>
    );
  }
  return (
    <main className="studio">
      <h2>{t('split_title')}</h2>
      <p className="hint">{boxes.length ? t('split_found', { n: num(lang, boxes.length) }) : t('split_none')}</p>
      <div className="split checker"><canvas ref={view} onClick={toggle} style={{ width: img.canvas.width * k, height: img.canvas.height * k }} /></div>
      {boxes.length > 0 && <Runner {...p} items={items} aiKey="split_bg_ai" />}
    </main>
  );
}

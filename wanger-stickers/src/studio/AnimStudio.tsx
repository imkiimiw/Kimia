// The animated studio (Phase 3, its own lazy chunk): a video, GIF, round video or animated
// sticker → Telegram video sticker, GIF / MP4, WhatsApp animated sticker, or a conversion.
// Edit: timeline with frame previews (start / end within the target's limit), speed, reverse,
// boomerang, smooth loop, frame (original / square), shape, background, one text layer.
// Export: frames are rendered once, encoded with bounded size targeting, re-validated by the
// server on upload. Nothing leaves the device until the user taps a save / send button.
import { useEffect, useMemo, useRef, useState } from 'react';
import { openSource, type AnimSource } from '../engine/anim/source';
import { defaultClip, clampClip, planFrames, outputMs, SPEEDS, type Clip, type Plan } from '../engine/anim/timeline';
import { newAnimDoc, makeRenderer, outputSize, renderAll, squareCrop, planTimes, type AnimDoc, type AnimShape, type AnimTarget } from '../engine/anim/compose';
import { FONTS, loadFont, type FontKey } from '../engine/text';
import { canvasToBlob } from '../engine/image';
import { trayIcon } from '../engine/export';
import { TELEGRAM, WHATSAPP, OUTPUT } from '../engine/limits';
import { saveFile, tg, type Boot, type SaveResult } from './api';
import { num, type makeT, type Lang } from './i18n';
import { TelegramChoice, defaultTgChoice, tgChoiceReady, saveTelegram, WhatsAppChoice, defaultWaChoice, waChoiceReady, saveWhatsApp, WaSaved, type TgChoice, type WaChoice } from './Targets';

type T = ReturnType<typeof makeT>;
export type Tab = 'telegram' | 'gif' | 'whatsapp' | 'convert';

const MAX_MS: Record<Tab, number> = { telegram: TELEGRAM.video.maxDurationMs, whatsapp: WHATSAPP.animated.maxDurationMs, gif: OUTPUT.gif.maxDurationMs, convert: OUTPUT.animation.maxDurationMs };
const DEFAULT_MS: Record<Tab, number> = { telegram: TELEGRAM.video.maxDurationMs, whatsapp: 3000, gif: 6000, convert: 10000 };
const ENGINE_TARGET: Record<Tab, AnimTarget> = { telegram: 'telegram', whatsapp: 'whatsapp', gif: 'gif', convert: 'webp' };
const PREVIEW = 300; // css px
const sec = (ms: number) => Math.round(ms / 100) / 10;

export interface AnimProps {
  blob: Blob;
  info: Boot;
  t: T;
  lang: Lang;
  initial: Tab;
  quick?: boolean;
  round?: boolean;
  onBack?: () => void;
  onAgain: () => void;
  onStatic: (b: Blob) => void;
  onError: (e: unknown) => void;
}

export default function AnimStudio(p: AnimProps) {
  const { blob, info, t } = p;
  const [src, setSrc] = useState<AnimSource | null>(null);
  const [failed, setFailed] = useState(false);
  const tabs = useMemo(() => (['telegram', 'gif', 'whatsapp', 'convert'] as Tab[]).filter((x) => (x === 'telegram' ? info.flags.video : x === 'gif' ? info.flags.gif_studio : x === 'whatsapp' ? info.flags.whatsapp : info.flags.convert)), [info]);
  const [tab, setTab] = useState<Tab>(tabs.includes(p.initial) ? p.initial : tabs[0] || 'telegram');
  const [doc, setDoc] = useState<AnimDoc | null>(null);
  const [stage, setStage] = useState<'edit' | 'export'>('edit');

  useEffect(() => {
    let live = true;
    let opened: AnimSource | null = null;
    openSource(blob)
      .then((s) => {
        opened = s;
        if (!live) return s.close();
        const d = newAnimDoc(clampClip(defaultClip(s.durationMs, DEFAULT_MS[tab]), s.durationMs, MAX_MS[tab]), !!p.round);
        if (p.round) d.crop = squareCrop(s);
        if (tab === 'whatsapp') d.crop = squareCrop(s);
        setSrc(s);
        setDoc(d);
        if (p.quick) setStage('export');
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      opened?.close();
    };
    // the source is opened once per file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);

  useEffect(() => {
    const bb = tg().BackButton;
    if (!bb) return;
    const back = () => (stage === 'export' && !p.quick ? setStage('edit') : p.onBack?.());
    if (stage === 'export' || p.onBack) {
      bb.show();
      bb.onClick(back);
      return () => bb.offClick(back);
    }
    bb.hide();
  }, [stage, p]);

  if (failed) return <main className="studio center"><p className="note">{t('decode_video_failed')}</p>{p.onBack && <button onClick={p.onBack}>{t('back_home')}</button>}</main>;
  if (!src || !doc) return <main className="studio center"><div className="spinner" /><p>{t('loading')}</p></main>;

  const switchTab = (x: Tab) => {
    setTab(x);
    setDoc({ ...doc, clip: clampClip(doc.clip, src.durationMs, MAX_MS[x]) });
  };
  return (
    <main className="studio">
      {tabs.length > 1 && (
        <div className="tabs4">
          {tabs.map((x) => <button key={x} className={x === tab ? 'on' : ''} onClick={() => switchTab(x)}>{t(`target_${x}` as const)}</button>)}
        </div>
      )}
      {stage === 'edit'
        ? <AnimEditor src={src} doc={doc} setDoc={setDoc} tab={tab} t={t} lang={p.lang} onNext={() => setStage('export')} />
        : <AnimExport key={tab} {...p} src={src} doc={doc} tab={tab} />}
    </main>
  );
}

/* ------------------------------------------------------------------ editor */

function AnimEditor({ src, doc, setDoc, tab, t, lang, onNext }: { src: AnimSource; doc: AnimDoc; setDoc: (d: AnimDoc) => void; tab: Tab; t: T; lang: Lang; onNext: () => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [playing, setPlaying] = useState<null | number>(null); // preparing progress, or -1 = playing
  const stopRef = useRef<() => void>(() => undefined);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const target = ENGINE_TARGET[tab];
  const size = useMemo(() => {
    const o = outputSize(doc, src, target, 512);
    const k = (PREVIEW * dpr) / Math.max(o.w, o.h);
    return { w: Math.max(2, Math.round(o.w * k)), h: Math.max(2, Math.round(o.h * k)) };
  }, [doc, src, target, dpr]);
  const clip = doc.clip;
  const max = MAX_MS[tab];
  const set = (c: Partial<Clip>) => setDoc({ ...doc, clip: clampClip({ ...clip, ...c }, src.durationMs, max) });

  // frame previews along the whole source (once)
  useEffect(() => {
    let live = true;
    void (async () => {
      const list: string[] = [];
      const n = 6;
      const tc = document.createElement('canvas');
      for (let i = 0; i < n && live; i++) {
        const f = await src.frameAt(((i + 0.5) * src.durationMs) / n);
        const k = 56 / Math.max(f.width, f.height);
        tc.width = Math.round(f.width * k);
        tc.height = Math.round(f.height * k);
        tc.getContext('2d')!.drawImage(f as CanvasImageSource, 0, 0, tc.width, tc.height);
        list.push(tc.toDataURL('image/jpeg', 0.7));
      }
      if (live) setThumbs(list);
    })();
    return () => {
      live = false;
    };
  }, [src]);

  // the poster: the first frame of the clip with shape / text, redrawn on every change
  useEffect(() => {
    if (playing !== null) return;
    let live = true;
    const r = makeRenderer(src, doc, target, size, undefined);
    void r.draw(planFrames(clip, 30, max).frames[0]).then((c) => {
      const el = canvas.current;
      if (!live || !el) return;
      el.width = size.w;
      el.height = size.h;
      const x = el.getContext('2d')!;
      x.clearRect(0, 0, size.w, size.h);
      x.drawImage(c as CanvasImageSource, 0, 0);
    });
    return () => {
      live = false;
    };
  }, [doc, size, src, target, clip, max, playing]);

  const play = async () => {
    if (playing !== null) return stopRef.current();
    setPlaying(0);
    const plan = planFrames(clip, 15, max);
    await src.prepare?.(planTimes(plan), (q) => setPlaying(Math.round(q * 100)));
    const r = makeRenderer(src, doc, target, size);
    const frames: ImageBitmap[] = [];
    for (const f of plan.frames) frames.push(await createImageBitmap(await r.draw(f)));
    setPlaying(-1);
    let i = 0;
    let stop = false;
    const tick = () => {
      if (stop) return;
      const el = canvas.current;
      if (el) {
        const x = el.getContext('2d')!;
        x.clearRect(0, 0, el.width, el.height);
        x.drawImage(frames[i % frames.length], 0, 0);
      }
      i++;
      setTimeout(tick, 1000 / plan.fps);
    };
    stopRef.current = () => {
      stop = true;
      frames.forEach((b) => b.close());
      setPlaying(null);
    };
    tick();
  };
  useEffect(() => () => stopRef.current(), []);

  const text = doc.texts[0];
  const setText = (patch: Partial<NonNullable<typeof text>> | null) => {
    if (patch === null) return setDoc({ ...doc, texts: [] });
    const base = text || { id: 't1', text: '', font: 'vazirmatn' as FontKey, size: 64, color: '#ffffff', stroke: '#000000', strokeWidth: 4, shadow: true, x: 0.5, y: 0.85, rotation: 0 };
    const next = { ...base, ...patch };
    if (patch.font) void loadFont(patch.font).then(() => setDoc({ ...doc, texts: [{ ...next }] }));
    setDoc({ ...doc, texts: [next] });
  };
  const outMs = outputMs(clip);
  const busy = playing !== null && playing >= 0;
  return (
    <div className="editor">
      <div className="view checker" style={{ width: size.w / dpr, height: size.h / dpr }}>
        <canvas ref={canvas} style={{ width: size.w / dpr, height: size.h / dpr }} />
        {busy && <div className="busy">{t('preview_working', { p: playing! })}</div>}
      </div>
      <button className="wide" onClick={() => void play()}>{playing === -1 ? t('preview_stop') : t('preview_play')}</button>
      <div className="panel">
        <div className="thumbs" dir="ltr">
          {thumbs.map((u, i) => <img key={i} src={u} alt="" />)}
          <div className="sel" style={{ left: `${(clip.startMs / src.durationMs) * 100}%`, width: `${((clip.endMs - clip.startMs) / src.durationMs) * 100}%` }} />
        </div>
        <label>{t('tl_start')} <input type="range" dir="ltr" min={0} max={Math.max(0, src.durationMs - 100)} step={50} value={clip.startMs} onChange={(e) => { const s = Number(e.target.value); set({ startMs: s, endMs: Math.max(s + 100, clip.endMs - clip.startMs + s) }); }} /> <small>{num(lang, sec(clip.startMs))}</small></label>
        <label>{t('tl_end')} <input type="range" dir="ltr" min={100} max={src.durationMs} step={50} value={clip.endMs} onChange={(e) => set({ endMs: Math.max(clip.startMs + 100, Number(e.target.value)) })} /> <small>{num(lang, sec(clip.endMs))}</small></label>
        <p className="hint">{t('tl_len', { s: num(lang, sec(outMs)), max: num(lang, sec(max)) })}</p>
        <div className="row">{SPEEDS.map((s) => <button key={s} className={clip.speed === s ? 'on' : ''} onClick={() => set({ speed: s })}>{num(lang, s)}×</button>)}</div>
        <div className="row">
          <button className={clip.reverse ? 'on' : ''} onClick={() => set({ reverse: !clip.reverse })}>{t('reverse')}</button>
          <button className={clip.boomerang ? 'on' : ''} onClick={() => set({ boomerang: !clip.boomerang })}>{t('boomerang')}</button>
          <button className={clip.loopFadeMs ? 'on' : ''} onClick={() => set({ loopFadeMs: clip.loopFadeMs ? 0 : 400 })}>{t('loop')}</button>
        </div>
      </div>
      <div className="panel">
        <span>{t('crop')}</span>
        <div className="row">
          <button className={doc.crop.w === 1 && doc.crop.h === 1 ? 'on' : ''} onClick={() => setDoc({ ...doc, crop: { x: 0, y: 0, w: 1, h: 1 } })}>{t('crop_original')}</button>
          <button className={doc.crop.w < 1 || doc.crop.h < 1 ? 'on' : ''} onClick={() => setDoc({ ...doc, crop: squareCrop(src) })}>{t('crop_square')}</button>
        </div>
        <div className="row">
          {(['none', 'circle', 'rounded'] as AnimShape[]).map((s) => <button key={s} className={doc.shape === s ? 'on' : ''} onClick={() => setDoc({ ...doc, shape: s })}>{t(s === 'none' ? 'shape_none' : s === 'circle' ? 'shape_circle' : 'shape_rounded')}</button>)}
        </div>
        <span>{t('anim_bg')}</span>
        <div className="row">
          <button className={doc.bg === null ? 'on' : ''} onClick={() => setDoc({ ...doc, bg: null })}>{t('bg_transparent')}</button>
          {['#ffffff', '#000000'].map((c) => <button key={c} className={doc.bg === c ? 'on' : ''} style={{ background: c, color: c === '#000000' ? '#fff' : '#000' }} onClick={() => setDoc({ ...doc, bg: c })}>■</button>)}
          <input type="color" value={doc.bg || '#ff3b6b'} onChange={(e) => setDoc({ ...doc, bg: e.target.value })} aria-label={t('anim_bg')} />
        </div>
      </div>
      <div className="panel">
        <textarea dir="auto" rows={2} placeholder={t('text_placeholder')} value={text ? text.text : ''} onChange={(e) => setText({ text: e.target.value })} />
        {text && (
          <>
            <div className="row">
              <select value={text.font} onChange={(e) => setText({ font: e.target.value as FontKey })}>{(Object.keys(FONTS) as FontKey[]).map((f) => <option key={f} value={f}>{FONTS[f].family.replace('WS ', '')}</option>)}</select>
              <input type="color" value={text.color} onChange={(e) => setText({ color: e.target.value })} aria-label={t('text_color')} />
            </div>
            <label>{t('text_size')} <input type="range" min={24} max={140} value={text.size} onChange={(e) => setText({ size: Number(e.target.value) })} /></label>
            <div className="row">{([['pos_top', 0.15], ['pos_middle', 0.5], ['pos_bottom', 0.85]] as const).map(([k, y]) => <button key={k} className={Math.abs(text.y - y) < 0.01 ? 'on' : ''} onClick={() => setText({ y })}>{t(k)}</button>)}</div>
            <button className="danger" onClick={() => setText(null)}>{t('text_delete')}</button>
          </>
        )}
      </div>
      <button className="primary" disabled={busy} onClick={() => { stopRef.current(); onNext(); }}>{t('make')}</button>
    </div>
  );
}

/* ------------------------------------------------------------------ export */

type Prog = { k: 'capturing' | 'rendering' | 'encoding'; p: number } | null;

async function framesFor(src: AnimSource, doc: AnimDoc, target: AnimTarget, fps: number, maxMs: number, setProg: (p: Prog) => void): Promise<{ frames: ImageData[]; plan: Plan }> {
  const plan = planFrames(doc.clip, fps, maxMs);
  setProg({ k: 'capturing', p: 0 });
  await src.prepare?.(planTimes(plan), (q) => setProg({ k: 'capturing', p: Math.round(q * 100) }));
  const r = makeRenderer(src, doc, target, outputSize(doc, src, target));
  const frames = await renderAll(r, plan, (q) => setProg({ k: 'rendering', p: Math.round(q * 100) }));
  return { frames, plan };
}

const kb = (n: number) => Math.round(n / 102.4) / 10;
const blobUrl = (b: Uint8Array, type: string) => URL.createObjectURL(new Blob([b as BlobPart], { type }));

function errText(t: T, e: unknown): string | null {
  const m = (e as Error)?.message;
  if (m === 'TOO_BIG') return t('too_big_anim');
  if (m === 'NO_VP9') return t('no_vp9');
  if (m === 'NO_H264') return t('no_h264');
  return null;
}

function Progress({ t, prog }: { t: T; prog: Prog }) {
  if (!prog) return null;
  return <div className="center"><div className="spinner" /><p>{t(prog.k, { p: prog.p })}</p></div>;
}

function AnimExport(p: AnimProps & { src: AnimSource; doc: AnimDoc; tab: Tab }) {
  if (p.tab === 'telegram') return <ExportTelegram {...p} />;
  if (p.tab === 'whatsapp') return <ExportWhatsApp {...p} />;
  return <ExportFiles {...p} />;
}

function ExportTelegram({ src, doc, info, t, lang, onError, onAgain }: AnimProps & { src: AnimSource; doc: AnimDoc }) {
  const [prog, setProg] = useState<Prog>(null);
  const [res, setRes] = useState<{ bytes: Uint8Array; url: string; line: string; violations: string[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [choice, setChoice] = useState<TgChoice>(() => defaultTgChoice(info));
  const [saving, setSaving] = useState<number | null>(null);
  const [done, setDone] = useState<SaveResult | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const fps = Math.min(TELEGRAM.video.maxFps, src.fps && src.fps < 30 ? Math.max(15, src.fps) : 30);
        const { frames } = await framesFor(src, doc, 'telegram', fps, TELEGRAM.video.maxDurationMs, setProg);
        setProg({ k: 'encoding', p: 0 });
        const { toTelegramVideo } = await import('../engine/anim/vp9');
        const out = await toTelegramVideo(frames, fps, (q) => setProg({ k: 'encoding', p: Math.round(q * 100) }));
        if (!live) return;
        setRes({ bytes: out.bytes, url: blobUrl(out.bytes, 'video/webm'), violations: out.violations, line: t('result_video', { w: out.width, h: out.height, fps: out.fps, s: num(lang, sec(out.durationMs)), kb: kb(out.bytes.length) }) });
      } catch (e) {
        if (!live) return;
        const m = errText(t, e);
        if (m) setMsg(m);
        else onError(e);
      } finally {
        if (live) setProg(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [src, doc, t, lang, onError]);
  if (done) {
    const text = done.action === 'new' ? t('saved_new', { title: choice.title || '' }) : done.action === 'add' ? t('saved_add', { title: info.packs.find((x) => x.id === choice.packId)?.title || '', n: done.count || 0 }) : t('saved_send');
    return (
      <div className="center">
        <p className="big">{text}</p>
        {done.name && <button className="primary" onClick={() => tg().openTelegramLink?.(`https://t.me/addstickers/${done.name}`)}>{t('open_pack')}</button>}
        <button onClick={onAgain}>{t('another')}</button>
        <button onClick={() => tg().close?.()}>{t('close')}</button>
      </div>
    );
  }
  if (msg) return <div className="center"><p className="note">{msg}</p></div>;
  if (!res) return <Progress t={t} prog={prog || { k: 'capturing', p: 0 }} />;
  const save = async () => {
    setSaving(0);
    try {
      const r = await saveTelegram(info, res.bytes, 'telegram_video', 'webm', choice, (q) => setSaving(Math.round(q * 100)));
      tg().HapticFeedback?.notificationOccurred('success');
      if (r.action === 'new' && r.packId) info.packs.unshift({ id: r.packId, title: (choice.title || '').trim(), count: 1, name: r.name || '' });
      setDone(r);
    } catch (e) {
      setSaving(null);
      tg().HapticFeedback?.notificationOccurred('error');
      onError(e);
    }
  };
  return (
    <div className="export">
      <h2>{t('save_title')}</h2>
      <div className="preview checker"><video src={res.url} autoPlay loop muted playsInline /></div>
      <p className="hint">{res.line}</p>
      {res.violations.length > 0 && <p className="note">{t('invalid', { why: res.violations.join(', ') })}</p>}
      <TelegramChoice info={info} t={t} lang={lang} value={choice} onChange={setChoice} />
      <button className="primary" disabled={saving !== null || res.violations.length > 0 || !tgChoiceReady(choice)} onClick={() => void save()}>{saving === null ? t('save_btn') : t('saving', { p: saving })}</button>
    </div>
  );
}

function ExportWhatsApp({ src, doc, info, t, lang, onError, onAgain }: AnimProps & { src: AnimSource; doc: AnimDoc }) {
  const [prog, setProg] = useState<Prog>(null);
  const [res, setRes] = useState<{ bytes: Uint8Array; url: string; first: ImageData; violations: string[]; line: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [choice, setChoice] = useState<WaChoice>(() => defaultWaChoice(info, 'animated'));
  const [saving, setSaving] = useState<number | null>(null);
  const [done, setDone] = useState<{ r: SaveResult; title: string } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const fps = Math.min(15, src.fps || 15);
        const { frames } = await framesFor(src, doc, 'whatsapp', fps, WHATSAPP.animated.maxDurationMs, setProg);
        setProg({ k: 'encoding', p: 0 });
        const { toWhatsAppAnimated } = await import('../engine/anim/awebp');
        const out = await toWhatsAppAnimated(frames, fps, (q) => setProg({ k: 'encoding', p: Math.round(q * 100) }));
        if (!live) return;
        setRes({ bytes: out.bytes, url: blobUrl(out.bytes, 'image/webp'), first: frames[0], violations: out.violations, line: t('result_file', { fmt: `WebP · ${num(lang, out.fps)} fps · ${num(lang, sec(out.durationMs))} s`, w: 512, h: 512, kb: kb(out.bytes.length) }) });
      } catch (e) {
        if (!live) return;
        const m = errText(t, e);
        if (m) setMsg(m);
        else onError(e);
      } finally {
        if (live) setProg(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [src, doc, t, lang, onError]);
  if (done) return <WaSaved info={info} t={t} lang={lang} result={done.r} title={done.title} onAgain={onAgain} />;
  if (msg) return <div className="center"><p className="note">{msg}</p></div>;
  if (!res) return <Progress t={t} prog={prog || { k: 'capturing', p: 0 }} />;
  const save = async () => {
    setSaving(0);
    try {
      const tray = async () => {
        const c = document.createElement('canvas');
        c.width = res.first.width;
        c.height = res.first.height;
        c.getContext('2d')!.putImageData(res.first, 0, 0);
        return (await trayIcon(c)).bytes;
      };
      const title = choice.packId === null ? choice.title.trim() : info.wa.find((x) => x.id === choice.packId)?.title || '';
      const r = await saveWhatsApp(info, res.bytes, 'animated', choice, tray, (q) => setSaving(Math.round(q * 100)));
      tg().HapticFeedback?.notificationOccurred('success');
      setDone({ r, title });
    } catch (e) {
      setSaving(null);
      tg().HapticFeedback?.notificationOccurred('error');
      onError(e);
    }
  };
  return (
    <div className="export">
      <h2>{t('wa_title')}</h2>
      <div className="preview checker"><img src={res.url} alt="" /></div>
      <p className="hint">{res.line}</p>
      {res.violations.length > 0 && <p className="note">{t('invalid', { why: res.violations.join(', ') })}</p>}
      <WhatsAppChoice info={info} t={t} lang={lang} kind="animated" value={choice} onChange={setChoice} />
      <button className="primary" disabled={saving !== null || res.violations.length > 0 || !waChoiceReady(choice)} onClick={() => void save()}>{saving === null ? t('save_btn') : t('saving', { p: saving })}</button>
    </div>
  );
}

/** GIF tab and Convert tab: files for the chat (MP4 animation, .gif, animated WebP, frames ZIP, first frame). */
function ExportFiles({ src, doc, info, t, lang, tab, onError, onStatic }: AnimProps & { src: AnimSource; doc: AnimDoc; tab: Tab }) {
  const [fps, setFps] = useState(15);
  const [side, setSide] = useState(360);
  const [prog, setProg] = useState<Prog>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const run = async (what: 'mp4' | 'gif' | 'webp' | 'zip' | 'first') => {
    setMsg(null);
    setSent(null);
    try {
      const maxMs = MAX_MS[tab];
      if (what === 'first') {
        const r = makeRenderer(src, doc, 'webp', outputSize(doc, src, 'webp', 1024));
        const c = await r.draw(planFrames(doc.clip, 30, maxMs).frames[0]);
        return onStatic(await canvasToBlob(c, 'image/png'));
      }
      if (what === 'webp') {
        const { frames } = await framesFor(src, doc, 'webp', Math.min(fps, 20), Math.min(maxMs, 10000), setProg);
        setProg({ k: 'encoding', p: 0 });
        const { toAnimatedWebpFile } = await import('../engine/anim/awebp');
        const out = await toAnimatedWebpFile(frames.map((f) => f), Math.min(fps, 20));
        await saveFile(out.bytes, 'webp_file', 'webp', { action: 'file' }, info.limits.chunkBytes, (q) => setProg({ k: 'encoding', p: Math.round(q * 100) }));
        return setSent(t('result_file', { fmt: 'WebP', w: out.width, h: out.height, kb: kb(out.bytes.length) }));
      }
      const plan = what === 'gif' ? planFrames(doc.clip, (await import('../engine/anim/gif')).gifPlanFps(fps), maxMs) : planFrames(doc.clip, what === 'zip' ? Math.min(fps, 10) : fps, maxMs);
      setProg({ k: 'capturing', p: 0 });
      await src.prepare?.(planTimes(plan), (q) => setProg({ k: 'capturing', p: Math.round(q * 100) }));
      const target: AnimTarget = what === 'mp4' ? 'mp4' : 'gif';
      const r = makeRenderer(src, doc, target, outputSize(doc, src, target, side), what === 'mp4' ? doc.bg || '#ffffff' : undefined);
      const onP = (q: number) => setProg({ k: 'encoding', p: Math.round(q * 100) });
      setProg({ k: 'encoding', p: 0 });
      if (what === 'mp4') {
        try {
          const { toMp4 } = await import('../engine/anim/mp4');
          const out = await toMp4(r, plan, onP);
          await saveFile(out.bytes, 'animation', 'mp4', { action: 'send' }, info.limits.chunkBytes);
          return setSent(t('result_file', { fmt: 'MP4', w: out.width, h: out.height, kb: kb(out.bytes.length) }));
        } catch (e) {
          if ((e as Error).message !== 'NO_H264') throw e;
          // no H.264 encoder: a GIF, sent so Telegram shows it as an animation
          const g = await (await import('../engine/anim/gif')).toGif(r, planFrames(doc.clip, (await import('../engine/anim/gif')).gifPlanFps(fps), maxMs), !doc.bg, onP);
          await saveFile(g.bytes, 'gif', 'gif', { action: 'send' }, info.limits.chunkBytes);
          return setSent(t('result_file', { fmt: 'GIF', w: g.width, h: g.height, kb: kb(g.bytes.length) }));
        }
      }
      if (what === 'gif') {
        const { toGif } = await import('../engine/anim/gif');
        const out = await toGif(r, plan, !doc.bg, onP);
        await saveFile(out.bytes, 'gif', 'gif', { action: 'file' }, info.limits.chunkBytes);
        return setSent(t('result_file', { fmt: 'GIF', w: out.width, h: out.height, kb: kb(out.bytes.length) }));
      }
      const { framesZip } = await import('../engine/anim/files');
      const zip = await framesZip(r, plan, onP);
      await saveFile(zip, 'frames_zip', 'zip', { action: 'file' }, info.limits.chunkBytes);
      return setSent(t('result_file', { fmt: 'ZIP', w: r.size.w, h: r.size.h, kb: kb(zip.length) }));
    } catch (e) {
      const m = errText(t, e);
      if (m) setMsg(m);
      else onError(e);
    } finally {
      setProg(null);
    }
  };
  if (prog) return <Progress t={t} prog={prog} />;
  return (
    <div className="export">
      <h2>{t(tab === 'gif' ? 'target_gif' : 'target_convert')}</h2>
      <label>{t('gif_fps')}<div className="row">{[10, 15, 20].map((f) => <button key={f} className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>{num(lang, f)}</button>)}</div></label>
      <label>{t('gif_size')}<div className="row">{[240, 360, 480].map((s) => <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{num(lang, s)}</button>)}</div></label>
      {sent && <p className="big">{t('sent_file')} <small className="hint">{sent}</small></p>}
      {msg && <p className="note">{msg}</p>}
      <button className="primary" onClick={() => void run('mp4')}>{t('send_gif_anim')}</button>
      <button className="wide" onClick={() => void run('gif')}>{t('send_gif_file')}</button>
      {tab === 'convert' && (
        <>
          <button className="wide" onClick={() => void run('webp')}>{t('send_webp_file')}</button>
          <button className="wide" onClick={() => void run('zip')}>{t('send_zip')}</button>
          {info.flags.studio && <button className="wide" onClick={() => void run('first')}>{t('first_frame')}</button>}
        </>
      )}
    </div>
  );
}

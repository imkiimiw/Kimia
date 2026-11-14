// The Studio. Flow: boot (the gate runs server-side) → a file from the chat (?job=) or a mode:
//   home        tiles for every mode whose feature is on
//   sticker     photo → static editor → Telegram (or WhatsApp) sticker            (Phase 2)
//   video / gif / convert / wa   video, GIF, round video, sticker → AnimStudio    (Phase 3, lazy)
//   split       screenshot to pack · batch   several photos, one setting         (Phase 3)
// ?quick=1: good defaults, straight to saving. Nothing leaves the device until the user saves.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { boot, downloadJob, jobInfo, saveSticker, tg, type Boot, type SaveResult, type ServerlessError } from './api';
import { makeT, num, type Lang } from './i18n';
import Editor from './Editor';
import { BatchScreen, SplitScreen } from './Batch';
import { WhatsAppChoice, defaultWaChoice, waChoiceReady, saveWhatsApp, WaSaved, type WaChoice } from './Targets';
import { loadImage } from '../engine/image';
import { Mask } from '../engine/mask';
import { newDoc, type StickerDoc } from '../engine/render';
import { removeBackground } from '../engine/segment';
import { toTelegramStatic, toWhatsAppStatic, trayIcon, type ExportResult } from '../engine/export';
import { loadFont } from '../engine/text';
import { sniffKind } from '../engine/anim/source';
import type { Tab } from './AnimStudio';

const AnimStudio = lazy(() => import('./AnimStudio'));

type Platform = 'telegram' | 'whatsapp';
type Step =
  | { k: 'boot' }
  | { k: 'outside' }
  | { k: 'gate'; channels: { title: string; url: string }[] }
  | { k: 'home' }
  | { k: 'pick'; what: 'image' | 'anim' | 'any'; tab: Tab }
  | { k: 'loading'; text: string }
  | { k: 'edit' }
  | { k: 'export' }
  | { k: 'anim'; blob: Blob; tab: Tab; round: boolean; quick: boolean }
  | { k: 'split'; blob: Blob | null }
  | { k: 'batch' }
  | { k: 'done'; result: SaveResult; title?: string }
  | { k: 'wadone'; result: SaveResult; title: string }
  | { k: 'error'; text: string };

const params = new URLSearchParams(location.search);
const JOB = params.get('job');
const QUICK = params.get('quick') === '1';
const MODE = params.get('mode') || '';
const WPACK = Number(params.get('wpack')) || null;
const ANIMATED_JOBS = new Set(['video', 'animation', 'video_note', 'gif', 'video_sticker', 'tgs']);
const TAB_OF: Record<string, Tab> = { video: 'telegram', gif: 'gif', convert: 'convert', wa: 'whatsapp' };

export default function Studio() {
  const startLang: Lang = (tg().initDataUnsafe?.user?.language_code || '').startsWith('en') ? 'en' : 'fa';
  const [lang, setLang] = useState<Lang>(startLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const [step, setStep] = useState<Step>({ k: 'boot' });
  const [info, setInfo] = useState<Boot | null>(null);
  const [doc, setDoc] = useState<StickerDoc | null>(null);
  const [platform, setPlatform] = useState<Platform>(MODE === 'wa' ? 'whatsapp' : 'telegram');

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  }, [lang]);

  const fail = useCallback((e: unknown) => {
    const err = e as ServerlessError;
    const code = err && err.parameters && err.parameters.code;
    if (code === 'JOIN_REQUIRED') return setStep({ k: 'gate', channels: err.parameters!.channels || [] });
    if (code === 'OUTSIDE_TELEGRAM') return setStep({ k: 'outside' });
    setStep({ k: 'error', text: makeT(lang)('error', { msg: (err && err.message) || String(e) }) });
  }, [lang]);

  /** A still image → the static editor (or straight to saving in quick mode). */
  const openDoc = useCallback(async (blob: Blob) => {
    setStep({ k: 'loading', text: t('loading') });
    let src;
    try {
      src = await loadImage(blob, 1024);
    } catch {
      return setStep({ k: 'error', text: t('decode_failed') });
    }
    const d = newDoc(src, new Mask(src.width, src.height));
    void loadFont('vazirmatn');
    if (QUICK) {
      setStep({ k: 'loading', text: t('bg_working') });
      try {
        const m = await removeBackground(src, 'general', (p) => setStep({ k: 'loading', text: p < 1 ? t('bg_model', { p: Math.round(p * 100) }) : t('bg_working') }));
        d.mask.set(m.data);
      } catch {
        /* keep the whole photo; the editor can erase by hand */
      }
      setDoc(d);
      return setStep({ k: 'export' });
    }
    setDoc(d);
    setStep({ k: 'edit' });
  }, [t]);

  /** Any picked file: images go to the static editor, the rest to the animated studio. */
  const openAny = useCallback(async (blob: Blob, tab: Tab, round = false, quick = false) => {
    if ((await sniffKind(blob)) === 'image') return openDoc(blob);
    setStep({ k: 'anim', blob, tab, round, quick });
  }, [openDoc]);

  const start = useCallback(async () => {
    setStep({ k: 'boot' });
    try {
      const b = await boot();
      setInfo(b);
      setLang(b.user.lang);
      const T2 = makeT(b.user.lang);
      if (JOB) {
        const meta = await jobInfo(JOB);
        setStep({ k: 'loading', text: T2('downloading', { p: 0 }) });
        const blob = await downloadJob(JOB, (p) => setStep({ k: 'loading', text: T2('downloading', { p: Math.round(p * 100) }) }));
        if (ANIMATED_JOBS.has(meta.kind)) return setStep({ k: 'anim', blob, tab: TAB_OF[MODE] || 'telegram', round: meta.kind === 'video_note', quick: QUICK });
        return openDoc(blob);
      }
      if (MODE === 'sticker') return setStep({ k: 'pick', what: 'image', tab: 'telegram' });
      if (MODE === 'video' || MODE === 'gif' || MODE === 'convert') return setStep({ k: 'pick', what: 'anim', tab: TAB_OF[MODE] });
      if (MODE === 'wa') return setStep({ k: 'pick', what: 'any', tab: 'whatsapp' });
      if (MODE === 'split') return setStep({ k: 'split', blob: null });
      if (MODE === 'batch') return setStep({ k: 'batch' });
      setStep({ k: 'home' });
    } catch (e) {
      fail(e);
    }
  }, [fail, openDoc]);

  useEffect(() => {
    tg().ready?.();
    tg().expand?.();
    void start();
  }, [start]);

  const home = useCallback(() => {
    setDoc(null);
    setStep({ k: 'home' });
  }, []);

  // Telegram's back button for the static flow: export → edit → home
  useEffect(() => {
    const bb = tg().BackButton;
    if (!bb) return;
    if (step.k === 'anim' || step.k === 'split' || step.k === 'batch') return; // they manage it
    const back = () => (step.k === 'export' ? setStep({ k: 'edit' }) : home());
    if (step.k === 'export' || step.k === 'pick' || (step.k === 'edit' && !JOB)) {
      bb.show();
      bb.onClick(back);
      return () => bb.offClick(back);
    }
    bb.hide();
  }, [step.k, home]);

  switch (step.k) {
    case 'boot':
    case 'loading':
      return <main className="studio center"><div className="spinner" /><p>{step.k === 'loading' ? step.text : t('loading')}</p></main>;
    case 'outside':
      return <main className="studio center"><p>{t('outside', { bot: info?.bot || 'Wanger_Motionbot' })}</p></main>;
    case 'error':
      return <main className="studio center"><p className="note">{step.text}</p><button onClick={() => void start()}>{t('retry')}</button></main>;
    case 'gate':
      return (
        <main className="studio center">
          <h2>{t('gate_title')}</h2>
          {step.channels.map((c) => (
            <button key={c.url} className="wide" onClick={() => (tg().openTelegramLink ? tg().openTelegramLink!(c.url) : window.open(c.url))}>➕ {c.title}</button>
          ))}
          <button className="primary" onClick={() => void start()}>{t('gate_check')}</button>
        </main>
      );
    case 'home':
      return <Home info={info!} t={t} go={(s) => { if (s.k === 'pick' && s.tab === 'whatsapp') setPlatform('whatsapp'); else if (s.k === 'pick') setPlatform('telegram'); setStep(s); }} />;
    case 'pick': {
      const what = step.what;
      const accept = what === 'image' ? 'image/*' : what === 'anim' ? 'video/*,image/gif,.gif,.webm,.tgs,.mp4,.mov' : 'image/*,video/*,.gif,.webm,.tgs';
      const title = what === 'image' ? t('pick_title') : what === 'anim' ? t('pick_video_title') : t('pick_any_title');
      const hint = what === 'image' ? t('pick_hint') : what === 'anim' ? t('pick_video_hint') : t('pick_any_hint');
      return (
        <main className="studio center">
          <h2>{title}</h2>
          <p className="hint">{hint}</p>
          <label className="primary file">
            {what === 'image' ? t('pick_btn') : t('pick_video_btn')}
            <input type="file" accept={accept} onChange={(e) => { const f = e.target.files?.[0]; if (f) void (what === 'image' ? openDoc(f) : openAny(f, step.tab)); }} />
          </label>
          <button onClick={home}>{t('back_home')}</button>
        </main>
      );
    }
    case 'edit':
      return <main className="studio">{doc && <Editor doc={doc} t={t} onNext={() => setStep({ k: 'export' })} />}</main>;
    case 'export':
      return (
        <main className="studio">
          {doc && info && (
            <ExportSheet doc={doc} info={info} t={t} lang={lang} platform={platform} setPlatform={setPlatform}
              onDone={(result, title) => setStep({ k: 'done', result, title })}
              onWaDone={(result, title) => setStep({ k: 'wadone', result, title })}
              onError={fail} />
          )}
        </main>
      );
    case 'anim':
      return (
        <Suspense fallback={<main className="studio center"><div className="spinner" /><p>{t('loading')}</p></main>}>
          <AnimStudio blob={step.blob} info={info!} t={t} lang={lang} initial={step.tab} round={step.round} quick={step.quick}
            onBack={JOB ? undefined : home} onAgain={home} onError={fail} onStatic={(b) => void openDoc(b)} />
        </Suspense>
      );
    case 'split':
      return <SplitScreen info={info!} t={t} lang={lang} blob={step.blob} onBack={home} onAgain={home} onError={fail} platform0={MODE === 'wa' ? 'whatsapp' : 'telegram'} />;
    case 'batch':
      return <BatchScreen info={info!} t={t} lang={lang} onBack={home} onAgain={home} onError={fail} />;
    case 'wadone':
      return <WaSaved info={info!} t={t} lang={lang} result={step.result} title={step.title} onAgain={home} />;
    case 'done':
      return <Done step={step} t={t} onAgain={home} />;
  }
}

/** The mode tiles; a mode appears only when its feature is on (brief §1 rule 7). */
function Home({ info, t, go }: { info: Boot; t: ReturnType<typeof makeT>; go: (s: Step) => void }) {
  const f = info.flags;
  const tiles: [string, Step, boolean][] = [
    [t('mode_sticker'), { k: 'pick', what: 'image', tab: 'telegram' }, f.studio],
    [t('mode_video'), { k: 'pick', what: 'anim', tab: 'telegram' }, f.video],
    [t('mode_gif'), { k: 'pick', what: 'anim', tab: 'gif' }, f.gif_studio || f.convert],
    [t('mode_wa'), { k: 'pick', what: 'any', tab: 'whatsapp' }, f.whatsapp],
    [t('mode_split'), { k: 'split', blob: null }, f.studio],
    [t('mode_batch'), { k: 'batch' }, f.studio],
  ];
  return (
    <main className="studio center">
      <h2>{t('home_title')}</h2>
      <div className="tiles">
        {tiles.filter(([, , on]) => on).map(([label, s]) => <button key={label} className="tile" onClick={() => go(s)}>{label}</button>)}
      </div>
    </main>
  );
}

function ExportSheet({ doc, info, t, lang, platform, setPlatform, onDone, onWaDone, onError }: {
  doc: StickerDoc; info: Boot; t: ReturnType<typeof makeT>; lang: Lang; platform: Platform; setPlatform: (p: Platform) => void;
  onDone: (r: SaveResult, title?: string) => void; onWaDone: (r: SaveResult, title: string) => void; onError: (e: unknown) => void;
}) {
  const [res, setRes] = useState<(ExportResult & { canvas?: unknown }) | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const free = info.packs.filter((p) => p.count < info.limits.set.maxStickersRegular);
  const [target, setTarget] = useState<string>(free.length ? `p${free[0].id}` : 'new');
  const [title, setTitle] = useState('');
  const [emojis, setEmojis] = useState('😀');
  const [wa, setWa] = useState<WaChoice>(() => {
    const c = defaultWaChoice(info, 'static');
    return WPACK && info.wa.some((p) => p.id === WPACK && p.kind === 'static') ? { ...c, packId: WPACK } : c;
  });
  const [saving, setSaving] = useState<number | null>(null);
  const isWa = platform === 'whatsapp' && info.flags.whatsapp;

  useEffect(() => {
    let live = true;
    setRes(null);
    void (isWa ? toWhatsAppStatic(doc) : toTelegramStatic(doc)).then(async (r) => {
      if (!live) return;
      setRes(r);
      setUrl(URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.format === 'webp' ? 'image/webp' : 'image/png' })));
    }).catch(onError);
    return () => {
      live = false;
    };
  }, [doc, onError, isWa]);

  const save = async () => {
    if (!res) return;
    setSaving(0);
    try {
      if (isWa) {
        const canvas = (res as unknown as { canvas: Parameters<typeof trayIcon>[0] }).canvas;
        const packTitle = wa.packId === null ? wa.title.trim() : info.wa.find((p) => p.id === wa.packId)?.title || '';
        const r = await saveWhatsApp(info, res.bytes, 'static', wa, async () => (await trayIcon(canvas)).bytes, (p) => setSaving(Math.round(p * 100)));
        tg().HapticFeedback?.notificationOccurred('success');
        return onWaDone(r, packTitle);
      }
      const tgt = target === 'new' ? { action: 'new' as const, title: title.trim() } : target === 'send' ? { action: 'send' as const } : { action: 'add' as const, packId: Number(target.slice(1)) };
      const r = await saveSticker(res.bytes, res.format, { ...tgt, emojis }, info.limits.chunkBytes, (p) => setSaving(Math.round(p * 100)));
      tg().HapticFeedback?.notificationOccurred('success');
      const pack = info.packs.find((p) => `p${p.id}` === target);
      onDone(r, target === 'new' ? title.trim() : pack?.title);
    } catch (e) {
      setSaving(null);
      tg().HapticFeedback?.notificationOccurred('error');
      onError(e);
    }
  };

  const kb = res ? Math.round(res.bytes.length / 102.4) / 10 : 0;
  return (
    <div className="export">
      {info.flags.whatsapp && (
        <div className="row">
          {(['telegram', 'whatsapp'] as Platform[]).map((p) => <button key={p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>{t(`platform_${p}` as const)}</button>)}
        </div>
      )}
      <h2>{isWa ? t('wa_title') : t('save_title')}</h2>
      {!res ? <div className="center"><div className="spinner" /><p>{t('loading')}</p></div> : (
        <>
          <div className="preview checker">{url && <img src={url} alt="" />}</div>
          <p className="hint">{isWa ? t('wa_preview', { kb }) : t('save_preview', { w: res.width, h: res.height, kb, fmt: res.format.toUpperCase() })}</p>
          {res.violations.length > 0 && <p className="note">{t('invalid', { why: res.violations.join(', ') })}</p>}
          {isWa ? <WhatsAppChoice info={info} t={t} lang={lang} kind="static" value={wa} onChange={setWa} /> : (
            <>
              <fieldset>
                <legend>{t('save_to_pack')}</legend>
                {info.packs.map((p) => {
                  const full = p.count >= info.limits.set.maxStickersRegular;
                  return (
                    <label key={p.id} className={`opt ${full ? 'off' : ''}`}>
                      <input type="radio" name="t" disabled={full} checked={target === `p${p.id}`} onChange={() => setTarget(`p${p.id}`)} />
                      <span dir="auto">{p.title}</span> <small>{full ? t('save_full') : num(info.user.lang, p.count)}</small>
                    </label>
                  );
                })}
                <label className="opt"><input type="radio" name="t" checked={target === 'new'} onChange={() => setTarget('new')} />{t('save_new')}</label>
                {target === 'new' && <input dir="auto" maxLength={info.limits.set.titleMaxChars} placeholder={t('save_title_ph')} value={title} onChange={(e) => setTitle(e.target.value)} />}
                <label className="opt"><input type="radio" name="t" checked={target === 'send'} onChange={() => setTarget('send')} />{t('save_send')}</label>
              </fieldset>
              <label>{t('save_emoji')}<input value={emojis} onChange={(e) => setEmojis(e.target.value)} /></label>
            </>
          )}
          <button className="primary" disabled={saving !== null || res.violations.length > 0 || (isWa ? !waChoiceReady(wa) : target === 'new' && !title.trim())} onClick={() => void save()}>
            {saving === null ? t('save_btn') : t('saving', { p: saving })}
          </button>
        </>
      )}
    </div>
  );
}

function Done({ step, t, onAgain }: { step: Extract<Step, { k: 'done' }>; t: ReturnType<typeof makeT>; onAgain: () => void }) {
  const r = step.result;
  const text = r.action === 'new' ? t('saved_new', { title: step.title || '' }) : r.action === 'add' ? t('saved_add', { title: step.title || '', n: r.count || 0 }) : t('saved_send');
  const link = r.name ? `https://t.me/addstickers/${r.name}` : null;
  return (
    <main className="studio center">
      <p className="big">{text}</p>
      {link && <button className="primary" onClick={() => (tg().openTelegramLink ? tg().openTelegramLink!(link) : window.open(link))}>{t('open_pack')}</button>}
      <button onClick={onAgain}>{t('another')}</button>
      <button onClick={() => tg().close?.()}>{t('close')}</button>
    </main>
  );
}

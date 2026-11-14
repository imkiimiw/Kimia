// The Studio. Flow: boot (the gate runs server-side) → a file from the chat (?job=) or a mode:
//   home        tiles for every mode whose feature is on (+ the last draft on this device)
//   sticker     photo → static editor → Telegram sticker / custom emoji / WhatsApp     (Phase 2–4)
//   video / gif / convert / wa   video, GIF, round video, sticker → AnimStudio          (Phase 3, lazy)
//   split       screenshot to pack · batch   several photos, one setting               (Phase 3)
//   emoji · meme · text (animation) · slideshow (photos or joined clips)              (Phase 4)
// ?quick=1: good defaults, straight to saving; ?pack=<id>: the destination pack.
// Nothing leaves the device until the user saves; drafts stay on the device (IndexedDB).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boot, downloadJob, jobInfo, tg, type Boot, type SaveResult, type ServerlessError } from './api';
import { makeT, type Lang } from './i18n';
import Editor from './Editor';
import { BatchScreen, SplitScreen } from './Batch';
import { WhatsAppChoice, defaultWaChoice, waChoiceReady, saveWhatsApp, WaSaved, TelegramChoice, defaultTgChoice, tgChoiceReady, saveTelegram, packLink, type WaChoice, type TgChoice } from './Targets';
import { saveDraft, loadDraft, clearDraft, staticSettings, debounce, type StaticDraft, type AnimDraft } from './drafts';
import { loadImage, canvasToBlob } from '../engine/image';
import { Mask } from '../engine/mask';
import { newDoc, renderSticker, type StickerDoc } from '../engine/render';
import { removeBackground } from '../engine/segment';
import { toTelegramStatic, toWhatsAppStatic, toCustomEmojiStatic, trayIcon, type ExportResult } from '../engine/export';
import { loadFont, memeLayer } from '../engine/text';
import { sniffKind } from '../engine/anim/source';
import type { Tab, AnimMode } from './AnimStudio';
import type { AnimDoc } from '../engine/anim/compose';

const AnimStudio = lazy(() => import('./AnimStudio'));

type Platform = 'telegram' | 'emoji' | 'whatsapp';
type Pick = 'image' | 'anim' | 'any' | 'multi';
type Step =
  | { k: 'boot' }
  | { k: 'outside' }
  | { k: 'gate'; channels: { title: string; url: string }[] }
  | { k: 'home' }
  | { k: 'pick'; what: Pick; tab: Tab; mode?: AnimMode }
  | { k: 'loading'; text: string }
  | { k: 'edit' }
  | { k: 'export' }
  | { k: 'anim'; blob: Blob; blobs?: Blob[]; tab: Tab; round: boolean; quick: boolean; mode?: AnimMode; emoji?: boolean; initialDoc?: AnimDoc | null }
  | { k: 'split'; blob: Blob | null }
  | { k: 'batch' }
  | { k: 'done'; result: SaveResult; title?: string; emoji?: boolean }
  | { k: 'wadone'; result: SaveResult; title: string }
  | { k: 'error'; text: string };

const params = new URLSearchParams(location.search);
const JOB = params.get('job');
const QUICK = params.get('quick') === '1';
const MODE = params.get('mode') || '';
const WPACK = Number(params.get('wpack')) || null;
const PACK = Number(params.get('pack')) || null;
const ANIMATED_JOBS = new Set(['video', 'animation', 'video_note', 'gif', 'video_sticker', 'tgs']);
const TAB_OF: Record<string, Tab> = { video: 'telegram', gif: 'gif', convert: 'convert', wa: 'whatsapp', emoji: 'telegram', meme: 'telegram', text: 'telegram', slideshow: 'gif' };

export default function Studio() {
  const startLang: Lang = (tg().initDataUnsafe?.user?.language_code || '').startsWith('en') ? 'en' : 'fa';
  const [lang, setLang] = useState<Lang>(startLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const [step, setStep] = useState<Step>({ k: 'boot' });
  const [info, setInfo] = useState<Boot | null>(null);
  const [doc, setDoc] = useState<StickerDoc | null>(null);
  const [platform, setPlatform] = useState<Platform>(MODE === 'wa' ? 'whatsapp' : MODE === 'emoji' ? 'emoji' : 'telegram');
  const [meme, setMeme] = useState(MODE === 'meme');
  const [draft, setDraft] = useState<{ kind: 'static' | 'anim'; at: number } | null>(null);
  const srcBlob = useRef<Blob | null>(null);

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

  /* ---------------- drafts ---------------- */
  const saveStatic = useMemo(() => debounce((d: StickerDoc) => {
    if (!srcBlob.current) return;
    void saveDraft('static', { at: Date.now(), src: srcBlob.current, w: d.mask.w, h: d.mask.h, mask: d.mask.data.slice(), doc: staticSettings(d) } as StaticDraft);
  }, 1200), []);
  const animDraftBlobs = useRef<{ blobs: Blob[]; mode: AnimMode; emoji: boolean } | null>(null);
  const saveAnim = useMemo(() => debounce((d: AnimDoc, tab: Tab) => {
    const b = animDraftBlobs.current;
    if (!b || b.mode === 'text') return; // a text animation has no file to keep
    void saveDraft('anim', { at: Date.now(), blobs: b.blobs, mode: b.mode, tab, emoji: b.emoji, doc: d } as AnimDraft);
  }, 1500), []);

  /** A still image → the static editor (or straight to saving in quick mode). */
  const openDoc = useCallback(async (blob: Blob, opts: { meme?: boolean; restore?: StaticDraft } = {}) => {
    setStep({ k: 'loading', text: t('loading') });
    let src;
    try {
      src = await loadImage(blob, 1024);
    } catch {
      return setStep({ k: 'error', text: t('decode_failed') });
    }
    srcBlob.current = blob;
    const d = newDoc(src, new Mask(src.width, src.height));
    void loadFont('vazirmatn');
    if (opts.restore && opts.restore.w === src.width && opts.restore.h === src.height) {
      Object.assign(d, opts.restore.doc);
      d.mask.set(opts.restore.mask);
    } else if (opts.meme) {
      // a meme keeps the whole photo, with the classic top / bottom captions
      d.outline.on = false;
      d.shadow = false;
      d.texts = [memeLayer(t('meme_top_sample'), 'top'), memeLayer(t('meme_bottom_sample'), 'bottom')];
    }
    setMeme(!!opts.meme);
    if (QUICK && !opts.restore) {
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

  /** Any picked file(s): images go to the static editor, the rest to the animated studio. */
  const openAny = useCallback(async (files: Blob[], tab: Tab, mode?: AnimMode) => {
    if (!files.length) return;
    const first = files[0];
    const kind = await sniffKind(first);
    if (files.length === 1 && kind === 'image' && mode !== 'slideshow') return openDoc(first, { meme: mode === 'meme' });
    const m: AnimMode = files.length > 1 ? (kind === 'image' ? 'slideshow' : 'join') : mode === 'meme' ? 'meme' : 'clip';
    animDraftBlobs.current = { blobs: files, mode: m, emoji: platform === 'emoji' };
    setStep({ k: 'anim', blob: first, blobs: files, tab, round: false, quick: false, mode: m, emoji: platform === 'emoji' });
  }, [openDoc, platform]);

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
        if (ANIMATED_JOBS.has(meta.kind)) {
          animDraftBlobs.current = { blobs: [blob], mode: MODE === 'meme' ? 'meme' : 'clip', emoji: MODE === 'emoji' };
          return setStep({ k: 'anim', blob, tab: TAB_OF[MODE] || 'telegram', round: meta.kind === 'video_note', quick: QUICK, mode: MODE === 'meme' ? 'meme' : 'clip', emoji: MODE === 'emoji' });
        }
        return openDoc(blob, { meme: MODE === 'meme' });
      }
      if (MODE === 'sticker') return setStep({ k: 'pick', what: 'image', tab: 'telegram' });
      if (MODE === 'video' || MODE === 'gif' || MODE === 'convert') return setStep({ k: 'pick', what: 'anim', tab: TAB_OF[MODE] });
      if (MODE === 'wa' || MODE === 'emoji' || MODE === 'meme') return setStep({ k: 'pick', what: 'any', tab: TAB_OF[MODE], mode: MODE === 'meme' ? 'meme' : undefined });
      if (MODE === 'text') return setStep({ k: 'anim', blob: new Blob([]), tab: 'telegram', round: false, quick: false, mode: 'text' });
      if (MODE === 'slideshow') return setStep({ k: 'pick', what: 'multi', tab: 'gif', mode: 'slideshow' });
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

  // the newest draft on this device, offered on the home screen
  useEffect(() => {
    if (step.k !== 'home') return;
    void Promise.all([loadDraft<StaticDraft>('static'), loadDraft<AnimDraft>('anim')]).then(([s, a]) => {
      if (s && (!a || s.at >= a.at)) setDraft({ kind: 'static', at: s.at });
      else if (a) setDraft({ kind: 'anim', at: a.at });
      else setDraft(null);
    });
  }, [step.k]);

  const resume = async () => {
    if (!draft) return;
    if (draft.kind === 'static') {
      const s = await loadDraft<StaticDraft>('static');
      if (s) return openDoc(s.src, { restore: s });
    } else {
      const a = await loadDraft<AnimDraft>('anim');
      if (a && a.blobs.length) {
        animDraftBlobs.current = { blobs: a.blobs, mode: a.mode, emoji: a.emoji };
        return setStep({ k: 'anim', blob: a.blobs[0], blobs: a.blobs, tab: a.tab, round: false, quick: false, mode: a.mode, emoji: a.emoji, initialDoc: a.doc });
      }
    }
    setDraft(null);
  };

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

  /** «🎬 متحرکش کن»: the finished still sticker → the animated studio with a motion effect. */
  const animate = async () => {
    if (!doc) return;
    const r = renderSticker(doc);
    if (!r) return;
    const blob = await canvasToBlob(r.canvas, 'image/png');
    animDraftBlobs.current = { blobs: [blob], mode: 'still', emoji: platform === 'emoji' };
    setStep({ k: 'anim', blob, tab: platform === 'whatsapp' ? 'whatsapp' : 'telegram', round: false, quick: false, mode: 'still', emoji: platform === 'emoji' });
  };

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
      return (
        <Home info={info!} t={t} draft={!!draft} onResume={() => void resume()} go={(s, p) => {
          setPlatform(p);
          if (s.k === 'anim' && s.mode === 'text') animDraftBlobs.current = null;
          setStep(s);
        }} />
      );
    case 'pick': {
      const what = step.what;
      const accept = what === 'image' ? 'image/*' : what === 'anim' ? 'video/*,image/gif,.gif,.webm,.tgs,.mp4,.mov' : 'image/*,video/*,.gif,.webm,.tgs';
      const title = what === 'image' ? t('pick_title') : what === 'anim' ? t('pick_video_title') : what === 'multi' ? t('pick_multi_title') : step.mode === 'meme' ? t('pick_meme_title') : platform === 'emoji' ? t('pick_emoji_title') : t('pick_any_title');
      const hint = what === 'image' ? t('pick_hint') : what === 'anim' ? t('pick_video_hint') : what === 'multi' ? t('pick_multi_hint') : step.mode === 'meme' ? t('pick_meme_hint') : platform === 'emoji' ? t('pick_emoji_hint') : t('pick_any_hint');
      return (
        <main className="studio center">
          <h2>{title}</h2>
          <p className="hint">{hint}</p>
          <label className="primary file">
            {what === 'image' ? t('pick_btn') : what === 'multi' ? t('pick_multi_btn') : t('pick_video_btn')}
            <input type="file" accept={accept} multiple={what === 'multi'} onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (!files.length) return;
              void (what === 'image' ? openDoc(files[0]) : openAny(what === 'multi' ? files.slice(0, 30) : [files[0]], step.tab, step.mode));
            }} />
          </label>
          <button onClick={home}>{t('back_home')}</button>
        </main>
      );
    }
    case 'edit':
      return <main className="studio">{doc && <Editor doc={doc} t={t} startTab={meme ? 'text' : undefined} onChange={() => saveStatic(doc)} onNext={() => setStep({ k: 'export' })} />}</main>;
    case 'export':
      return (
        <main className="studio">
          {doc && info && (
            <ExportSheet doc={doc} info={info} t={t} lang={lang} platform={platform} setPlatform={setPlatform} onAnimate={info.flags.video ? () => void animate() : undefined}
              onDone={(result, title, emoji) => { void clearDraft('static'); setStep({ k: 'done', result, title, emoji }); }}
              onWaDone={(result, title) => { void clearDraft('static'); setStep({ k: 'wadone', result, title }); }}
              onError={fail} />
          )}
        </main>
      );
    case 'anim':
      return (
        <Suspense fallback={<main className="studio center"><div className="spinner" /><p>{t('loading')}</p></main>}>
          <AnimStudio blob={step.blob} blobs={step.blobs} mode={step.mode} emoji={step.emoji} packId={PACK} initialDoc={step.initialDoc} info={info!} t={t} lang={lang} initial={step.tab} round={step.round} quick={step.quick}
            onDocChange={saveAnim} onBack={JOB ? undefined : home} onAgain={() => { void clearDraft('anim'); home(); }} onError={fail} onStatic={(b) => void openDoc(b)} />
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
function Home({ info, t, go, draft, onResume }: { info: Boot; t: ReturnType<typeof makeT>; go: (s: Step, p: Platform) => void; draft: boolean; onResume: () => void }) {
  const f = info.flags;
  const tiles: [string, Step, Platform, boolean][] = [
    [t('mode_sticker'), { k: 'pick', what: 'image', tab: 'telegram' }, 'telegram', f.studio],
    [t('mode_video'), { k: 'pick', what: 'anim', tab: 'telegram' }, 'telegram', f.video],
    [t('mode_emoji'), { k: 'pick', what: 'any', tab: 'telegram' }, 'emoji', !!f.emoji],
    [t('mode_meme'), { k: 'pick', what: 'any', tab: 'telegram', mode: 'meme' }, 'telegram', f.studio],
    [t('mode_gif'), { k: 'pick', what: 'anim', tab: 'gif' }, 'telegram', f.gif_studio || f.convert],
    [t('mode_text'), { k: 'anim', blob: new Blob([]), tab: 'telegram', round: false, quick: false, mode: 'text' }, 'telegram', f.video || f.gif_studio],
    [t('mode_slideshow'), { k: 'pick', what: 'multi', tab: 'gif', mode: 'slideshow' }, 'telegram', f.gif_studio],
    [t('mode_wa'), { k: 'pick', what: 'any', tab: 'whatsapp' }, 'whatsapp', f.whatsapp],
    [t('mode_split'), { k: 'split', blob: null }, 'telegram', f.studio],
    [t('mode_batch'), { k: 'batch' }, 'telegram', f.studio],
  ];
  return (
    <main className="studio center">
      <h2>{t('home_title')}</h2>
      {draft && <button className="primary" onClick={onResume}>{t('draft_resume')}</button>}
      <div className="tiles">
        {tiles.filter(([, , , on]) => on).map(([label, s, p]) => <button key={label} className="tile" onClick={() => go(s, p)}>{label}</button>)}
      </div>
    </main>
  );
}

function ExportSheet({ doc, info, t, lang, platform, setPlatform, onDone, onWaDone, onError, onAnimate }: {
  doc: StickerDoc; info: Boot; t: ReturnType<typeof makeT>; lang: Lang; platform: Platform; setPlatform: (p: Platform) => void;
  onDone: (r: SaveResult, title: string, emoji: boolean) => void; onWaDone: (r: SaveResult, title: string) => void; onError: (e: unknown) => void; onAnimate?: () => void;
}) {
  const [res, setRes] = useState<(ExportResult & { canvas?: unknown }) | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [tgc, setTgc] = useState<TgChoice>(() => defaultTgChoice(info, platform === 'emoji' ? 'emoji' : 'sticker', PACK));
  const [wa, setWa] = useState<WaChoice>(() => {
    const c = defaultWaChoice(info, 'static');
    return WPACK && info.wa.some((p) => p.id === WPACK && p.kind === 'static') ? { ...c, packId: WPACK } : c;
  });
  const [saving, setSaving] = useState<number | null>(null);
  const plat: Platform = platform === 'whatsapp' && !info.flags.whatsapp ? 'telegram' : platform === 'emoji' && !info.flags.emoji ? 'telegram' : platform;
  const platforms: Platform[] = ['telegram', ...(info.flags.emoji ? ['emoji' as const] : []), ...(info.flags.whatsapp ? ['whatsapp' as const] : [])];

  useEffect(() => {
    let live = true;
    setRes(null);
    void (plat === 'whatsapp' ? toWhatsAppStatic(doc) : plat === 'emoji' ? toCustomEmojiStatic(doc) : toTelegramStatic(doc)).then(async (r) => {
      if (!live) return;
      setRes(r);
      setUrl(URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.format === 'webp' ? 'image/webp' : 'image/png' })));
    }).catch(onError);
    return () => {
      live = false;
    };
  }, [doc, onError, plat]);

  const switchTo = (p: Platform) => {
    setPlatform(p);
    if (p !== 'whatsapp') setTgc(defaultTgChoice(info, p === 'emoji' ? 'emoji' : 'sticker', PACK));
  };

  const save = async () => {
    if (!res) return;
    setSaving(0);
    try {
      if (plat === 'whatsapp') {
        const canvas = (res as unknown as { canvas: Parameters<typeof trayIcon>[0] }).canvas;
        const packTitle = wa.packId === null ? wa.title.trim() : info.wa.find((p) => p.id === wa.packId)?.title || '';
        const r = await saveWhatsApp(info, res.bytes, 'static', wa, async () => (await trayIcon(canvas)).bytes, (p) => setSaving(Math.round(p * 100)));
        tg().HapticFeedback?.notificationOccurred('success');
        return onWaDone(r, packTitle);
      }
      const title = tgc.action === 'new' ? (tgc.title || '').trim() : info.packs.find((p) => p.id === tgc.packId)?.title || '';
      const r = await saveTelegram(info, res.bytes, plat === 'emoji' ? 'emoji_static' : 'telegram_static', res.format, tgc, (p) => setSaving(Math.round(p * 100)));
      tg().HapticFeedback?.notificationOccurred('success');
      onDone(r, title, plat === 'emoji');
    } catch (e) {
      setSaving(null);
      tg().HapticFeedback?.notificationOccurred('error');
      onError(e);
    }
  };

  const kb = res ? Math.round(res.bytes.length / 102.4) / 10 : 0;
  return (
    <div className="export">
      {platforms.length > 1 && (
        <div className="row">
          {platforms.map((p) => <button key={p} className={plat === p ? 'on' : ''} onClick={() => switchTo(p)}>{t(`platform_${p}` as const)}</button>)}
        </div>
      )}
      <h2>{plat === 'whatsapp' ? t('wa_title') : plat === 'emoji' ? t('save_title_emoji') : t('save_title')}</h2>
      {!res ? <div className="center"><div className="spinner" /><p>{t('loading')}</p></div> : (
        <>
          <div className={`preview checker ${plat === 'emoji' ? 'small' : ''}`}>{url && <img src={url} alt="" />}</div>
          <p className="hint">{plat === 'whatsapp' ? t('wa_preview', { kb }) : t('save_preview', { w: res.width, h: res.height, kb, fmt: res.format.toUpperCase() })}</p>
          {res.violations.length > 0 && <p className="note">{t('invalid', { why: res.violations.join(', ') })}</p>}
          {plat === 'whatsapp'
            ? <WhatsAppChoice info={info} t={t} lang={lang} kind="static" value={wa} onChange={setWa} />
            : <TelegramChoice info={info} t={t} lang={lang} value={tgc} onChange={setTgc} kind={plat === 'emoji' ? 'emoji' : 'sticker'} />}
          <button className="primary" disabled={saving !== null || res.violations.length > 0 || (plat === 'whatsapp' ? !waChoiceReady(wa) : !tgChoiceReady(tgc))} onClick={() => void save()}>
            {saving === null ? t('save_btn') : t('saving', { p: saving })}
          </button>
          {onAnimate && <button className="wide" onClick={onAnimate}>{t('animate_it')}</button>}
        </>
      )}
    </div>
  );
}

function Done({ step, t, onAgain }: { step: Extract<Step, { k: 'done' }>; t: ReturnType<typeof makeT>; onAgain: () => void }) {
  const r = step.result;
  const text = r.action === 'new' ? t('saved_new', { title: step.title || '' }) : r.action === 'add' ? t('saved_add', { title: step.title || '', n: r.count || 0 }) : t('saved_send');
  const link = r.name ? packLink(r.name, step.emoji ? 'emoji' : 'sticker') : null;
  return (
    <main className="studio center">
      <p className="big">{text}</p>
      {link && <button className="primary" onClick={() => (tg().openTelegramLink ? tg().openTelegramLink!(link) : window.open(link))}>{t('open_pack')}</button>}
      <button onClick={onAgain}>{t('another')}</button>
      <button onClick={() => tg().close?.()}>{t('close')}</button>
    </main>
  );
}


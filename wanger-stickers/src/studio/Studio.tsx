// The Studio (Phase 2: static stickers). Flow: boot (the gate runs server-side) → a photo from the
// chat (?job=) or picked on the device → editor → export sheet (pack / new pack / send) → done.
// ?quick=1: automatic background removal with good defaults, straight to the export sheet.
// Nothing leaves the device until the user saves.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { boot, downloadJob, saveSticker, tg, type Boot, type SaveResult, type ServerlessError } from './api';
import { makeT, num, type Lang } from './i18n';
import Editor from './Editor';
import { loadImage } from '../engine/image';
import { Mask } from '../engine/mask';
import { newDoc, type StickerDoc } from '../engine/render';
import { removeBackground } from '../engine/segment';
import { toTelegramStatic, type ExportResult } from '../engine/export';
import { loadFont } from '../engine/text';

type Step =
  | { k: 'boot' }
  | { k: 'outside' }
  | { k: 'gate'; channels: { title: string; url: string }[] }
  | { k: 'pick' }
  | { k: 'loading'; text: string }
  | { k: 'edit' }
  | { k: 'export' }
  | { k: 'done'; result: SaveResult; title?: string }
  | { k: 'error'; text: string };

const params = new URLSearchParams(location.search);
const JOB = params.get('job');
const QUICK = params.get('quick') === '1';

export default function Studio() {
  const startLang: Lang = (tg().initDataUnsafe?.user?.language_code || '').startsWith('en') ? 'en' : 'fa';
  const [lang, setLang] = useState<Lang>(startLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const [step, setStep] = useState<Step>({ k: 'boot' });
  const [info, setInfo] = useState<Boot | null>(null);
  const [doc, setDoc] = useState<StickerDoc | null>(null);

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

  const start = useCallback(async () => {
    setStep({ k: 'boot' });
    try {
      const b = await boot();
      setInfo(b);
      setLang(b.user.lang);
      if (JOB) {
        setStep({ k: 'loading', text: makeT(b.user.lang)('downloading', { p: 0 }) });
        const blob = await downloadJob(JOB, (p) => setStep({ k: 'loading', text: makeT(b.user.lang)('downloading', { p: Math.round(p * 100) }) }));
        await openDoc(blob);
      } else setStep({ k: 'pick' });
    } catch (e) {
      fail(e);
    }
  }, [fail, openDoc]);

  useEffect(() => {
    tg().ready?.();
    tg().expand?.();
    void start();
  }, [start]);

  // Telegram's back button: export → edit → pick
  useEffect(() => {
    const bb = tg().BackButton;
    if (!bb) return;
    const back = () => setStep(step.k === 'export' ? { k: 'edit' } : { k: 'pick' });
    if (step.k === 'export' || (step.k === 'edit' && !JOB)) {
      bb.show();
      bb.onClick(back);
      return () => bb.offClick(back);
    }
    bb.hide();
  }, [step.k]);

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
    case 'pick':
      return (
        <main className="studio center">
          <h2>{t('pick_title')}</h2>
          <p className="hint">{t('pick_hint')}</p>
          <label className="primary file">
            {t('pick_btn')}
            <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void openDoc(f); }} />
          </label>
        </main>
      );
    case 'edit':
      return <main className="studio">{doc && <Editor doc={doc} t={t} onNext={() => setStep({ k: 'export' })} />}</main>;
    case 'export':
      return <main className="studio">{doc && info && <ExportSheet doc={doc} info={info} t={t} onDone={(result, title) => setStep({ k: 'done', result, title })} onError={fail} />}</main>;
    case 'done':
      return <Done step={step} t={t} onAgain={() => { setDoc(null); setStep({ k: 'pick' }); }} />;
  }
}

function ExportSheet({ doc, info, t, onDone, onError }: { doc: StickerDoc; info: Boot; t: ReturnType<typeof makeT>; onDone: (r: SaveResult, title?: string) => void; onError: (e: unknown) => void }) {
  const [res, setRes] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const free = info.packs.filter((p) => p.count < info.limits.set.maxStickersRegular);
  const [target, setTarget] = useState<string>(free.length ? `p${free[0].id}` : 'new');
  const [title, setTitle] = useState('');
  const [emojis, setEmojis] = useState('😀');
  const [saving, setSaving] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void toTelegramStatic(doc).then(async (r) => {
      if (!live) return;
      setRes(r);
      setUrl(URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.format === 'webp' ? 'image/webp' : 'image/png' })));
    }).catch(onError);
    return () => { live = false; };
  }, [doc, onError]);

  const save = async () => {
    if (!res) return;
    const tgt = target === 'new' ? { action: 'new' as const, title: title.trim() } : target === 'send' ? { action: 'send' as const } : { action: 'add' as const, packId: Number(target.slice(1)) };
    setSaving(0);
    try {
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

  if (!res) return <div className="center"><div className="spinner" /><p>{t('loading')}</p></div>;
  const kb = Math.round(res.bytes.length / 102.4) / 10;
  return (
    <div className="export">
      <h2>{t('save_title')}</h2>
      <div className="preview checker">{url && <img src={url} alt="" />}</div>
      <p className="hint">{t('save_preview', { w: res.width, h: res.height, kb, fmt: res.format.toUpperCase() })}</p>
      {res.violations.length > 0 && <p className="note">{t('invalid', { why: res.violations.join(', ') })}</p>}
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
      <button className="primary" disabled={saving !== null || res.violations.length > 0 || (target === 'new' && !title.trim())} onClick={() => void save()}>
        {saving === null ? t('save_btn') : t('saving', { p: saving })}
      </button>
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


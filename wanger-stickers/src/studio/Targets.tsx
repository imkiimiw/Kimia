// Where a finished sticker goes: a Telegram pack (existing / new / just send) or a WhatsApp pack
// (existing of the same kind / new with name + publisher), with emojis. Shared by the static
// editor, the animated studio, screenshot-to-pack and batch mode.
import { useState } from 'react';
import { saveFile, waExport, tg, type Boot, type SaveResult, type UploadKind, type UploadFormat, type WaPack } from './api';
import { num, type makeT, type Lang } from './i18n';
import { suggestEmojis } from '../../tgcloud/lib/core/suggest.js';

/** Emoji chips suggested from the sticker's own text (the local AiProvider; no network). */
function EmojiChips({ hint, max, onPick }: { hint?: string; max: number; onPick: (e: string) => void }) {
  if (!hint || !hint.trim()) return null;
  const list = suggestEmojis(hint, max) as string[];
  return (
    <div className="row chips">
      <button onClick={() => onPick(list.join(''))}>{list.join('')}</button>
      {list.length > 1 && list.map((e) => <button key={e} onClick={() => onPick(e)}>{e}</button>)}
    </div>
  );
}

type T = ReturnType<typeof makeT>;

export interface TgChoice {
  action: 'add' | 'new' | 'send';
  packId?: number;
  title?: string;
  emojis: string;
  repaint?: boolean; // a new custom emoji pack whose emoji take the text colour
}

export type TgKind = 'sticker' | 'emoji';
const packsOf = (info: Boot, kind: TgKind) => info.packs.filter((p) => (p.kind || 'sticker') === kind);
export const maxOf = (info: Boot, kind: TgKind) => (kind === 'emoji' ? info.limits.set.maxStickersEmoji || 200 : info.limits.set.maxStickersRegular);

/**
 * Pack radio list + new title + "just send" + emojis. `kind` = regular stickers or custom emoji
 * (their packs never mix); `allowSend` = false for batches and emoji.
 */
export function TelegramChoice({ info, t, lang, value, onChange, allowSend = true, kind = 'sticker', hint }: { info: Boot; t: T; lang: Lang; value: TgChoice; onChange: (c: TgChoice) => void; allowSend?: boolean; kind?: TgKind; hint?: string }) {
  const max = maxOf(info, kind);
  const packs = packsOf(info, kind);
  if (kind === 'emoji') allowSend = false;
  const key = value.action === 'add' ? `p${value.packId}` : value.action;
  const pick = (k: string) => onChange(k === 'new' ? { ...value, action: 'new' } : k === 'send' ? { ...value, action: 'send' } : { ...value, action: 'add', packId: Number(k.slice(1)) });
  return (
    <>
      <fieldset>
        <legend>{t('save_to_pack')}</legend>
        {packs.map((p) => {
          const full = p.count >= max;
          return (
            <label key={p.id} className={`opt ${full ? 'off' : ''}`}>
              <input type="radio" name="tgt" disabled={full} checked={key === `p${p.id}`} onChange={() => pick(`p${p.id}`)} />
              <span dir="auto">{p.title}</span> <small>{full ? t('save_full') : num(lang, p.count)}</small>
            </label>
          );
        })}
        <label className="opt"><input type="radio" name="tgt" checked={key === 'new'} onChange={() => pick('new')} />{t('save_new')}</label>
        {value.action === 'new' && <input dir="auto" maxLength={info.limits.set.titleMaxChars} placeholder={t(kind === 'emoji' ? 'emoji_title_ph' : 'save_title_ph')} value={value.title || ''} onChange={(e) => onChange({ ...value, title: e.target.value })} />}
        {value.action === 'new' && kind === 'emoji' && <label className="opt"><input type="checkbox" checked={!!value.repaint} onChange={(e) => onChange({ ...value, repaint: e.target.checked })} />{t('emoji_repaint')}</label>}
        {allowSend && <label className="opt"><input type="radio" name="tgt" checked={key === 'send'} onChange={() => pick('send')} />{t('save_send')}</label>}
      </fieldset>
      <label>{t('save_emoji')}<input value={value.emojis} onChange={(e) => onChange({ ...value, emojis: e.target.value })} /></label>
      <EmojiChips hint={hint} max={3} onPick={(e) => onChange({ ...value, emojis: e })} />
    </>
  );
}

export const tgChoiceReady = (c: TgChoice) => c.action !== 'new' || !!(c.title || '').trim();
export const defaultTgChoice = (info: Boot, kind: TgKind = 'sticker', packId?: number | null): TgChoice => {
  const free = packsOf(info, kind).filter((p) => p.count < maxOf(info, kind));
  const want = packId ? free.find((p) => p.id === packId) : null;
  const pick = want || free[0];
  return pick ? { action: 'add', packId: pick.id, emojis: '😀' } : { action: 'new', title: '', emojis: '😀' };
};

export interface WaChoice {
  packId: number | null; // null = new
  title: string;
  publisher: string;
  emojis: string;
}

export function defaultWaChoice(info: Boot, kind: 'static' | 'animated'): WaChoice {
  const max = info.limits.whatsapp.pack.maxStickers;
  const p = info.wa.find((x) => x.kind === kind && x.count < max);
  return { packId: p ? p.id : null, title: '', publisher: info.user.username ? `@${info.user.username}` : info.user.first_name || '', emojis: '😀' };
}
export const waChoiceReady = (c: WaChoice) => c.packId !== null || (!!c.title.trim() && !!c.publisher.trim());

export function WhatsAppChoice({ info, t, lang, kind, value, onChange, hint }: { info: Boot; t: T; lang: Lang; kind: 'static' | 'animated'; value: WaChoice; onChange: (c: WaChoice) => void; hint?: string }) {
  const P = info.limits.whatsapp.pack;
  const packs = info.wa.filter((p) => p.kind === kind);
  return (
    <>
      <fieldset>
        <legend>{t('wa_title')}</legend>
        <p className="hint">{t('wa_only_kind', { kind: t(kind === 'static' ? 'wa_kind_static' : 'wa_kind_animated') })}</p>
        {packs.map((p) => {
          const full = p.count >= P.maxStickers;
          return (
            <label key={p.id} className={`opt ${full ? 'off' : ''}`}>
              <input type="radio" name="wat" disabled={full} checked={value.packId === p.id} onChange={() => onChange({ ...value, packId: p.id })} />
              <span dir="auto">{p.title}</span> <small>{full ? t('wa_full') : `${num(lang, p.count)}/${num(lang, P.maxStickers)}`}</small>
            </label>
          );
        })}
        <label className="opt"><input type="radio" name="wat" checked={value.packId === null} onChange={() => onChange({ ...value, packId: null })} />{t('wa_new')}</label>
        {value.packId === null && (
          <>
            <input dir="auto" maxLength={P.nameMaxChars} placeholder={t('wa_name_ph')} value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} />
            <input dir="auto" maxLength={P.publisherMaxChars} placeholder={t('wa_publisher_ph')} value={value.publisher} onChange={(e) => onChange({ ...value, publisher: e.target.value })} />
          </>
        )}
      </fieldset>
      <label>{t('wa_emoji')}<input value={value.emojis} onChange={(e) => onChange({ ...value, emojis: e.target.value })} /></label>
      <EmojiChips hint={hint} max={info.limits.whatsapp.pack.emojiPerStickerMax} onPick={(e) => onChange({ ...value, emojis: e })} />
    </>
  );
}

/** Uploads one Telegram sticker (static or video) to the chosen target. */
export async function saveTelegram(info: Boot, bytes: Uint8Array, kind: UploadKind, format: UploadFormat, c: TgChoice, onProgress?: (p: number) => void, quiet = false): Promise<SaveResult> {
  const emoji = kind === 'emoji_static' || kind === 'emoji_video';
  const target = c.action === 'new' ? { action: 'new' as const, title: (c.title || '').trim(), ...(emoji && c.repaint ? { repaint: true } : {}) } : c.action === 'send' ? { action: 'send' as const } : { action: 'add' as const, packId: c.packId };
  const r = await saveFile(bytes, kind, format, { ...target, emojis: c.emojis, ...(quiet ? { quiet: true } : {}) }, info.limits.chunkBytes, onProgress);
  // keep the boot data current for the next sticker of this session
  if (r.action === 'new' && r.packId && !info.packs.some((p) => p.id === r.packId)) info.packs.unshift({ id: r.packId, title: (c.title || '').trim(), count: 1, name: r.name || '', kind: emoji ? 'emoji' : 'sticker' });
  else if (r.action === 'add') {
    const p = info.packs.find((x) => x.id === c.packId);
    if (p && r.count) p.count = r.count;
  }
  return r;
}

/** The Telegram link that adds a pack (custom emoji packs use addemoji). */
export const packLink = (name: string, kind: TgKind) => `https://t.me/${kind === 'emoji' ? 'addemoji' : 'addstickers'}/${name}`;

/**
 * Uploads one WhatsApp sticker; when the pack has no tray icon yet, uploads it too. Returns the
 * result and the pack id (a new pack's id comes back from the server).
 */
export async function saveWhatsApp(info: Boot, bytes: Uint8Array, kind: 'static' | 'animated', c: WaChoice, tray: () => Promise<Uint8Array>, onProgress?: (p: number) => void): Promise<SaveResult> {
  const uk: UploadKind = kind === 'static' ? 'whatsapp_static' : 'whatsapp_animated';
  const target = c.packId === null ? { action: 'wa_new' as const, title: c.title.trim(), publisher: c.publisher.trim() } : { action: 'wa_add' as const, packId: c.packId };
  const r = await saveFile(bytes, uk, 'webp', { ...target, emojis: c.emojis }, info.limits.chunkBytes, onProgress);
  if (r.needTray && r.packId) await saveFile(await tray(), 'whatsapp_tray', 'png', { action: 'wa_tray', packId: r.packId }, info.limits.chunkBytes);
  // keep the boot data current for the next sticker of this session
  const known = info.wa.find((p) => p.id === r.packId);
  if (known) {
    known.count = r.count ?? known.count + 1;
    known.tray = true;
  } else if (r.packId) info.wa.unshift({ id: r.packId, title: c.title.trim(), publisher: c.publisher.trim(), kind, count: r.count ?? 1, tray: true } as WaPack);
  return r;
}

/** After a WhatsApp save: progress towards the minimum, and the ZIP button once it is reached. */
export function WaSaved({ info, t, lang, result, title, onAgain }: { info: Boot; t: T; lang: Lang; result: SaveResult; title: string; onAgain: () => void }) {
  const P = info.limits.whatsapp.pack;
  const [zip, setZip] = useState<'idle' | 'busy' | 'sent' | string>('idle');
  const n = result.count || 0;
  const send = async () => {
    setZip('busy');
    try {
      await waExport(result.packId!);
      tg().HapticFeedback?.notificationOccurred('success');
      setZip('sent');
    } catch (e) {
      setZip((e as Error).message || 'error');
    }
  };
  return (
    <main className="studio center">
      <p className="big">{t('wa_saved', { title, n: num(lang, n), max: num(lang, P.maxStickers) })}</p>
      {n < P.minStickers && <p className="hint">{t('wa_need_more', { min: num(lang, P.minStickers), left: num(lang, P.minStickers - n) })}</p>}
      {n >= P.minStickers && zip !== 'sent' && <button className="primary" disabled={zip === 'busy'} onClick={() => void send()}>{zip === 'busy' ? t('loading') : t('wa_zip')}</button>}
      {zip === 'sent' && <p>{t(info.androidApp ? 'wa_zip_sent_app' : 'wa_zip_sent')}</p>}
      {zip !== 'idle' && zip !== 'busy' && zip !== 'sent' && <p className="note">{t('error', { msg: zip })}</p>}
      <button onClick={onAgain}>{t('another')}</button>
      <button onClick={() => tg().close?.()}>{t('close')}</button>
    </main>
  );
}

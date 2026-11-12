// The Studio's link to the bot: Telegram.WebApp.Serverless.call (it sends the verified init data)
// plus the chunked transfer protocol. Bytes travel as base64 in JSON.
import { sha256Hex, toBase64, fromBase64 } from '../../tgcloud/lib/core/bytes.js';

export interface ServerlessError extends Error {
  type?: string;
  parameters?: Record<string, unknown> & { code?: string; channels?: { title: string; url: string }[] };
}

interface TgWebApp {
  initData?: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; language_code?: string }; start_param?: string };
  platform?: string;
  version?: string;
  colorScheme?: string;
  themeParams?: Record<string, string>;
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string) => void;
  isVersionAtLeast?: (v: string) => boolean;
  HapticFeedback?: { impactOccurred: (s: string) => void; notificationOccurred: (s: string) => void };
  MainButton?: { setText: (t: string) => void; show: () => void; hide: () => void; onClick: (f: () => void) => void; offClick: (f: () => void) => void; showProgress?: () => void; hideProgress?: () => void; enable?: () => void; disable?: () => void };
  BackButton?: { show: () => void; hide: () => void; onClick: (f: () => void) => void; offClick: (f: () => void) => void };
  Serverless?: { call: (name: string, input: object, cb: (err: ServerlessError | null, result?: unknown) => void) => void };
}
export const tg = (): TgWebApp => (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp || {};

export function call<T>(name: string, input: object = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = tg().Serverless;
    if (!s) return reject(Object.assign(new Error('OUTSIDE_TELEGRAM'), { parameters: { code: 'OUTSIDE_TELEGRAM' } }));
    s.call(name, input, (err, result) => (err ? reject(err) : resolve(result as T)));
  });
}

export interface Boot {
  user: { id: number; first_name: string; lang: 'fa' | 'en' };
  role: string;
  packs: { id: number; title: string; count: number; name: string }[];
  quota: { pack_create: number; sticker_add: number };
  limits: { static: { side: number; maxBytes: number }; set: { maxStickersRegular: number; titleMaxChars: number }; chunkBytes: number };
  bot: string;
}

export const boot = () => call<Boot>('studio_boot');
export const jobInfo = (job: string) => call<{ job: string; kind: string; mime: string | null; size: number }>('studio_job', { job });

/** Downloads a chat job's file in chunks. */
export async function downloadJob(job: string, onProgress?: (p: number) => void): Promise<Blob> {
  const first = await call<{ idx: number; total: number; size: number; b64: string }>('studio_media', { job, idx: 0 });
  const parts: Uint8Array[] = [fromBase64(first.b64)!];
  onProgress?.(1 / first.total);
  for (let i = 1; i < first.total; i++) {
    const r = await call<{ b64: string }>('studio_media', { job, idx: i });
    parts.push(fromBase64(r.b64)!);
    onProgress?.((i + 1) / first.total);
  }
  return new Blob(parts as BlobPart[]);
}

export interface SaveTarget {
  action: 'add' | 'new' | 'send';
  packId?: number;
  title?: string;
  emojis?: string;
}
export interface SaveResult {
  action: string;
  packId?: number;
  name?: string;
  count?: number;
}

/** Sends the finished sticker: one call when it fits a chunk, else begin → chunks → commit. */
export async function saveSticker(bytes: Uint8Array, format: 'webp' | 'png', target: SaveTarget, chunkBytes: number, onProgress?: (p: number) => void): Promise<SaveResult> {
  const sha256 = await sha256Hex(bytes);
  if (bytes.length <= chunkBytes) {
    onProgress?.(0.5);
    return call<SaveResult>('upload_commit', { inline: toBase64(bytes), format, size: bytes.length, sha256, ...target });
  }
  const b = await call<{ uploadId: string; chunkBytes: number; chunks: number }>('upload_begin', { kind: 'telegram_static', format, size: bytes.length, sha256 });
  for (let i = 0; i < b.chunks; i++) {
    await call('upload_chunk', { uploadId: b.uploadId, idx: i, b64: toBase64(bytes.subarray(i * b.chunkBytes, (i + 1) * b.chunkBytes)) });
    onProgress?.((i + 1) / (b.chunks + 1));
  }
  return call<SaveResult>('upload_commit', { uploadId: b.uploadId, ...target });
}

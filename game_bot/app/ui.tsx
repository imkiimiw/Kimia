// Small shared UI pieces: icons, avatar, buttons with haptics, segmented control, toasts, overlay,
// countdown ring, game art.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ART } from './art.js';
import { n } from './i18n';
import { haptic } from './tg';

const ICONS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  trophy: 'M7 4h10v3a5 5 0 0 1-10 0zM5 5H3v2a4 4 0 0 0 4 4M19 5h2v2a4 4 0 0 1-4 4M9 14h6l-1 4h-4zM8 21h8',
  user: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM4 21a8 8 0 0 1 16 0',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  share: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14',
  play: 'M7 4.5v15l13-7.5z',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  check: 'M5 12.5l4.5 4.5L19 7',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  bot: 'M12 3v3M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9 13h.01M15 13h.01M9 16h6',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  backspace: 'M22 5H9l-6 7 6 7h13zM12 9l6 6M18 9l-6 6',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  leave: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11',
};

export function Icon({ name, size = 22, fill = false }: { name: string; size?: number; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const AVATAR_COLORS = ['#7458ff', '#ff4f8b', '#16b5a3', '#ff9a3c', '#3a8bff', '#c04bff', '#1fc37a', '#e8505b'];

export function Avatar({ name, size = '', bot = false, seed }: { name: string; size?: '' | 'sm' | 'lg'; bot?: boolean; seed?: string | number }) {
  const key = String(seed ?? name);
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const bg = bot ? 'linear-gradient(135deg,#5b6274,#2f3443)' : `linear-gradient(135deg, ${AVATAR_COLORS[h % AVATAR_COLORS.length]}, ${AVATAR_COLORS[(h >>> 3) % AVATAR_COLORS.length]})`;
  const letter = Array.from(String(name || '?').replace(/[^\p{L}\p{N}]/gu, ''))[0] || '?';
  return (
    <div class={`avatar ${size}`} style={{ background: bg }}>
      {bot ? <Icon name="bot" size={size === 'sm' ? 16 : 22} /> : letter.toUpperCase()}
    </div>
  );
}

type BtnProps = {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  small?: boolean;
  block?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
  class?: string;
};

export function Button({ kind = 'primary', small, block, disabled, onClick, children, class: cls = '' }: BtnProps) {
  return (
    <button
      class={`btn ${kind}${small ? ' small' : ''}${block ? ' block' : ''} ${cls}`}
      disabled={disabled}
      onClick={() => {
        haptic.tap();
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented">
      {options.map((o) => (
        <button
          key={String(o.value)}
          class={o.value === value ? 'on' : ''}
          onClick={() => {
            if (o.value !== value) haptic.select();
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function GameArt({ game, size = 64 }: { game: string; size?: number }) {
  return <div class="art" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: (ART as Record<string, string>)[game] }} />;
}

export function Spinner() {
  return <div class="spinner" />;
}

export function Overlay({ children }: { children: ComponentChildren }) {
  return (
    <div class="overlay">
      <div class="sheet">{children}</div>
    </div>
  );
}

/* A ring that empties as the turn's time runs out. */
export function TimerRing({ left, total, size = 34 }: { left: number; total: number; size?: number }) {
  const [now, setNow] = useState(Date.now());
  const [end] = useState(() => Date.now() + left * 1000);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const remain = Math.max(0, (end - now) / 1000);
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const frac = total ? remain / total : 0;
  const low = remain <= 10;
  return (
    <div class={`timer${low ? ' low' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" stroke-width="3" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={low ? 'var(--bad)' : 'var(--brand)'} stroke-width="3" stroke-linecap="round"
          stroke-dasharray={c} stroke-dashoffset={c * (1 - frac)} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset 250ms linear' }} />
      </svg>
      <span>{n(Math.ceil(remain))}</span>
    </div>
  );
}

/* ---------- toasts ---------- */

type Toast = { id: number; text: string; kind: '' | 'good' | 'bad' };
let toastId = 0;
let pushToast: (t: Toast) => void = () => {};

export function toast(text: string, kind: '' | 'good' | 'bad' = '') {
  if (kind === 'bad') haptic.error();
  pushToast({ id: ++toastId, text, kind });
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((list) => list.concat([t]).slice(-3));
      window.setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), 2600);
    };
  }, []);
  return (
    <div class="toast-wrap">
      {items.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

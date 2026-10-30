// Game artwork as SVG strings: the Mini App's game cards, and (rendered to PNG by
// scripts/thumbs.mjs) the inline-mode thumbnails. Everything is drawn here; no external images.

const defs = (id, a, b) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;

export const ART = {
  ttt: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><defs>${defs('tg', '#ff6b7d', '#ff3d6e')}${defs('tb', '#46b4ff', '#2f6bff')}${defs('tbg', '#2b2350', '#4a2d7a')}</defs>
<rect width="120" height="120" rx="28" fill="url(#tbg)"/>
<g stroke="rgba(255,255,255,.18)" stroke-width="4" stroke-linecap="round"><path d="M46 22v76M74 22v76M22 46h76M22 74h76"/></g>
<g stroke="url(#tg)" stroke-width="8" stroke-linecap="round"><path d="M27 27l13 13M40 27L27 40"/><path d="M83 55l13 13M96 55L83 68"/><path d="M55 83l13 13M68 83L55 96"/></g>
<g fill="none" stroke="url(#tb)" stroke-width="7"><circle cx="61.5" cy="33.5" r="8"/><circle cx="33.5" cy="89.5" r="8"/></g></svg>`,

  bg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><defs>${defs('bw', '#8a5531', '#5a321b')}${defs('bd', '#ffffff', '#e8e2d6')}</defs>
<rect width="120" height="120" rx="28" fill="url(#bw)"/>
<rect x="12" y="12" width="96" height="96" rx="12" fill="#0d6b4d"/>
<g><path d="M14 14l8 40 8-40z" fill="#e9cfa5"/><path d="M30 14l8 40 8-40z" fill="#a2462f"/><path d="M46 14l8 40 8-40z" fill="#e9cfa5"/><path d="M62 14l8 40 8-40z" fill="#a2462f"/><path d="M78 14l8 40 8-40z" fill="#e9cfa5"/><path d="M94 14l7 40 6-40z" fill="#a2462f"/></g>
<g transform="rotate(-14 44 82)"><rect x="28" y="66" width="32" height="32" rx="8" fill="url(#bd)" stroke="rgba(0,0,0,.15)"/><g fill="#22202a"><circle cx="36" cy="74" r="3"/><circle cx="44" cy="82" r="3"/><circle cx="52" cy="90" r="3"/></g></g>
<g transform="rotate(12 80 84)"><rect x="64" y="68" width="32" height="32" rx="8" fill="url(#bd)" stroke="rgba(0,0,0,.15)"/><g fill="#22202a"><circle cx="72" cy="76" r="3"/><circle cx="88" cy="76" r="3"/><circle cx="72" cy="92" r="3"/><circle cx="88" cy="92" r="3"/><circle cx="80" cy="84" r="3"/></g></g></svg>`,

  hokm: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><defs>${defs('hf', '#0f7a57', '#07402d')}${defs('hc', '#ffffff', '#efeae0')}</defs>
<rect width="120" height="120" rx="28" fill="url(#hf)"/>
<g transform="rotate(-18 60 92)"><rect x="40" y="30" width="40" height="58" rx="7" fill="url(#hc)" stroke="rgba(0,0,0,.12)"/><text x="47" y="46" font-family="Georgia,serif" font-size="14" font-weight="700" fill="#1d1d26">A</text><text x="60" y="70" font-size="20" text-anchor="middle" fill="#1d1d26">♠</text></g>
<g transform="rotate(0 60 92)"><rect x="40" y="26" width="40" height="58" rx="7" fill="url(#hc)" stroke="rgba(0,0,0,.12)"/><text x="47" y="42" font-family="Georgia,serif" font-size="14" font-weight="700" fill="#e23b4e">K</text><text x="60" y="66" font-size="20" text-anchor="middle" fill="#e23b4e">♥</text></g>
<g transform="rotate(18 60 92)"><rect x="40" y="30" width="40" height="58" rx="7" fill="url(#hc)" stroke="rgba(0,0,0,.12)"/><text x="47" y="46" font-family="Georgia,serif" font-size="14" font-weight="700" fill="#e23b4e">Q</text><text x="60" y="70" font-size="20" text-anchor="middle" fill="#e23b4e">♦</text></g>
<path d="M44 104l6-10 10 7 10-7 6 10z" fill="#ffc24b"/></svg>`,

  codeword: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><defs>${defs('cb', '#0e9f95', '#145e8a')}</defs>
<rect width="120" height="120" rx="28" fill="url(#cb)"/>
<g font-family="Inter,Arial,sans-serif" font-weight="800" font-size="16" text-anchor="middle">
<rect x="14" y="30" width="17" height="22" rx="5" fill="rgba(255,255,255,.95)"/><text x="22.5" y="46" fill="#0e5f73">W</text>
<rect x="34" y="30" width="17" height="22" rx="5" fill="rgba(255,255,255,.95)"/><text x="42.5" y="46" fill="#0e5f73">O</text>
<rect x="54" y="30" width="17" height="22" rx="5" fill="#ffc24b"/><text x="62.5" y="46" fill="#5b3a00">R</text>
<rect x="74" y="30" width="17" height="22" rx="5" fill="rgba(255,255,255,.95)"/><text x="82.5" y="46" fill="#0e5f73">D</text>
<rect x="94" y="30" width="17" height="22" rx="5" fill="rgba(255,255,255,.35)"/><text x="102.5" y="46" fill="#fff">?</text></g>
<g font-family="Inter,Arial,sans-serif" font-weight="800" font-size="14" fill="#fff"><circle cx="40" cy="80" r="14" fill="rgba(255,255,255,.18)"/><text x="40" y="85" text-anchor="middle">3</text><circle cx="80" cy="80" r="14" fill="rgba(255,255,255,.18)"/><text x="80" y="85" text-anchor="middle">1</text></g>
<g fill="none" stroke="#fff" stroke-width="2.5" stroke-opacity=".8"><circle cx="40" cy="80" r="18"/><path d="M80 98a18 18 0 1 0-15-8"/></g></svg>`,

  fusion: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><defs>${defs('fb', '#2a1f5c', '#5a2a8a')}${defs('f1', '#5ee0ff', '#3a8bff')}${defs('f2', '#a77bff', '#6c4bff')}${defs('f3', '#ff7ac0', '#ff4f8b')}${defs('f4', '#ffd060', '#ff9a3c')}</defs>
<rect width="120" height="120" rx="28" fill="url(#fb)"/>
<g font-family="Inter,Arial,sans-serif" font-weight="800" text-anchor="middle" fill="#fff">
<rect x="18" y="18" width="38" height="38" rx="10" fill="url(#f1)"/><text x="37" y="43" font-size="20">1</text>
<rect x="64" y="18" width="38" height="38" rx="10" fill="url(#f2)"/><text x="83" y="43" font-size="20">2</text>
<rect x="18" y="64" width="38" height="38" rx="10" fill="url(#f3)"/><text x="37" y="89" font-size="20">3</text>
<rect x="64" y="64" width="38" height="38" rx="10" fill="url(#f4)"/><text x="83" y="89" font-size="20">4</text></g>
<g stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-opacity=".9"><path d="M60 50v20M50 60h20"/></g></svg>`,
};

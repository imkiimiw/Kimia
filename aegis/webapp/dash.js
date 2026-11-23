// A group's statistics dashboard: asks the dash endpoint (which checks the admin live) for 30 days
// of numbers and draws them with plain SVG. Names come from the server and are set with
// textContent only.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const chat = Number(new URLSearchParams(location.search).get('c'));
  let fmt = (n) => String(n);
  let T = {};
  const tip = $('tip');

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  function html(tag, cls, text, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  /* a clean top for the axis: 1, 2 or 5 × 10^n at or above the largest value */
  function niceMax(v) {
    if (v <= 4) return Math.max(4, v);
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  /* the tooltip: rows of [color or null, value, label], and the date or hour under them */
  function showTip(ev, rows, when) {
    tip.replaceChildren();
    for (const [color, value, label] of rows) {
      const r = html('div', 'row', null, tip);
      if (color) html('i', null, null, r).style.background = color;
      html('b', null, value, r);
      if (label) html('span', null, label, r);
    }
    if (when) html('div', 'when', when, tip);
    tip.hidden = false;
    const x = (ev.clientX !== undefined ? ev.clientX : ev.target.getBoundingClientRect().left) + 12;
    const y = (ev.clientY !== undefined ? ev.clientY : ev.target.getBoundingClientRect().top) - 12;
    tip.style.left = `${Math.min(x, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, y - tip.offsetHeight)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  /* how many gridlines make round steps for this axis top (50 → 10s, 200 → 50s, 4 → 1s) */
  function tickCount(max) {
    if (max <= 5) return max;
    const m = Math.round(max / Math.pow(10, Math.floor(Math.log10(max))));
    return m === 2 ? 4 : 5;
  }

  const W = 600;
  const H = 180;
  const PAD = { l: 34, r: 10, t: 14, b: 22 };

  function axis(svg, max, ticks) {
    for (let i = 0; i <= ticks; i += 1) {
      const v = (max / ticks) * i;
      const y = PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
      el('line', { class: 'grid', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }, svg);
      el('text', { x: PAD.l - 6, y: y + 3, 'text-anchor': 'end' }, svg).textContent = fmt(Math.round(v));
    }
  }

  /* columns from one baseline, 4px round top, the largest labelled (a zero day has no mark; the tooltip and table still give it);
     axis labels every `tickEvery` columns counted back from the last, so the newest is always labelled and none collide */
  function columns(target, values, labels, tickEvery, tipLabel) {
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const max = niceMax(Math.max(1, ...values));
    axis(svg, max, tickCount(max));
    const band = (W - PAD.l - PAD.r) / values.length;
    const bw = Math.min(24, Math.max(2, band - 2));
    const base = H - PAD.b;
    const top = values.indexOf(Math.max(...values));
    values.forEach((v, i) => {
      const x = PAD.l + band * i + (band - bw) / 2;
      const h = ((base - PAD.t) * v) / max;
      const hit = el('rect', { class: 'hit', x: PAD.l + band * i, y: PAD.t, width: band, height: base - PAD.t, tabindex: 0 }, svg);
      if (h > 0) {
        const r = Math.min(4, bw / 2, h);
        el('path', { class: 'bar', d: `M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + bw - r}Q${x + bw},${base - h} ${x + bw},${base - h + r}V${base}Z` }, svg);
      }
      const on = (ev) => showTip(ev, [[null, fmt(v), tipLabel]], labels[i]);
      hit.addEventListener('pointermove', on);
      hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('blur', hideTip);
      if ((values.length - 1 - i) % tickEvery === 0) el('text', { x: PAD.l + band * i + band / 2, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = labels[i].slice(-5);
      if (i === top && v > 0) el('text', { class: 'label', x: x + bw / 2, y: base - h - 4, 'text-anchor': 'middle' }, svg).textContent = fmt(v);
    });
    target.replaceChildren(svg);
  }

  /* 2px lines with a 10% wash under a single series, an end dot and end value; a crosshair snaps to the day */
  function lines(target, series, labels) {
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
    axis(svg, max, tickCount(max));
    const n = labels.length;
    const xOf = (i) => PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1);
    const yOf = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
    for (const s of series) {
      const pts = s.values.map((v, i) => `${xOf(i)},${yOf(v)}`);
      if (series.length === 1) el('path', { class: 'area', fill: s.color, d: `M${xOf(0)},${yOf(0)}L${pts.join('L')}L${xOf(n - 1)},${yOf(0)}Z` }, svg);
      el('path', { class: 'line', stroke: s.color, d: `M${pts.join('L')}` }, svg);
      el('circle', { class: 'dot', cx: xOf(n - 1), cy: yOf(s.values[n - 1]), r: 4, fill: s.color }, svg);
    }
    if (series.length === 1) el('text', { class: 'label', x: xOf(n - 1) - 6, y: yOf(series[0].values[n - 1]) - 8, 'text-anchor': 'end' }, svg).textContent = fmt(series[0].values[n - 1]);
    for (let i = n - 1; i >= 0; i -= 7) el('text', { x: xOf(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = labels[i].slice(-5);
    const cross = el('line', { class: 'cross', y1: PAD.t, y2: H - PAD.b, visibility: 'hidden' }, svg);
    const hit = el('rect', { class: 'hit', x: PAD.l, y: PAD.t, width: W - PAD.l - PAD.r, height: H - PAD.t - PAD.b, tabindex: 0 }, svg);
    let focusIdx = n - 1;
    const at = (ev, i) => {
      cross.setAttribute('x1', xOf(i));
      cross.setAttribute('x2', xOf(i));
      cross.setAttribute('visibility', 'visible');
      showTip(ev, series.map((s) => [s.color, fmt(s.values[i]), s.name]), labels[i]);
    };
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const x = ((ev.clientX - box.left) / box.width) * W;
      at(ev, Math.max(0, Math.min(n - 1, Math.round(((x - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1)))));
    });
    hit.addEventListener('focus', (ev) => at(ev, focusIdx));
    hit.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      focusIdx = Math.max(0, Math.min(n - 1, focusIdx + (ev.key === 'ArrowRight' ? 1 : -1)));
      at(ev, focusIdx);
    });
    const off = () => { cross.setAttribute('visibility', 'hidden'); hideTip(); };
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('blur', off);
    target.replaceChildren(svg);
  }

  /* horizontal bars for ranked lists: the value at the tip */
  function hbars(target, items) {
    target.replaceChildren();
    if (!items.length) {
      html('p', 'muted', T.none, target);
      return;
    }
    const max = Math.max(...items.map((x) => x.value), 1);
    for (const it of items) {
      const row = html('div', 'row', null, target);
      html('span', 'name', it.name, row);
      const track = html('span', 'track', null, row);
      html('span', 'fill', null, track).style.width = `${Math.max(1, (it.value / max) * 78)}%`;
      html('span', 'num', fmt(it.value), track);
    }
  }

  function render(d) {
    T = d.text;
    document.documentElement.lang = d.lang;
    document.documentElement.dir = d.rtl ? 'rtl' : 'ltr';
    const nf = new Intl.NumberFormat(d.lang === 'fa' ? 'fa-IR' : d.lang);
    fmt = (n) => nf.format(n);
    const css = getComputedStyle(document.querySelector('.viz-root'));
    const c1 = css.getPropertyValue('--series-1').trim();
    const c2 = css.getPropertyValue('--series-2').trim();
    $('title').textContent = `${T.title} — ${d.title}`;
    $('note').textContent = T.note;
    const tiles = $('tiles');
    /* the headline numbers: the value is the loud part, its name under it */
    const tile = (k, text) => { const t = html('div', 'tile', null, tiles); html('span', 'v', text, t); html('span', 'k', k, t); };
    tile(`${T.messages} · ${T.today}`, fmt(d.totals.d1.messages));
    tile(`${T.messages} · ${T.d7}`, fmt(d.totals.d7.messages));
    tile(`${T.active} · ${T.d7}`, fmt(d.totals.d7.writers));
    tile(`${T.joins} / ${T.leaves} · ${T.d7}`, `${fmt(d.totals.d7.joins)} / ${fmt(d.totals.d7.leaves)}`);
    if (d.members) tile(T.count, fmt(d.members));
    /* 30 days, the missing ones as 0 */
    const byDay = new Map(d.days.map((x) => [x.day, x]));
    const labels = [];
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    for (let i = 29; i >= 0; i -= 1) labels.push(new Date(today - i * 86400000).toISOString().slice(0, 10));
    const col = (k) => labels.map((l) => (byDay.get(l) ? byDay.get(l)[k] : 0));
    $('h-messages').textContent = `${T.messages} · ${T.d30}`;
    columns($('c-messages'), col('messages'), labels, 7, T.messages);
    $('h-active').textContent = `${T.active} · ${T.d30}`;
    lines($('c-active'), [{ name: T.active, color: c1, values: col('active') }], labels);
    $('h-members').textContent = `${T.joins} / ${T.leaves} · ${T.d30}`;
    const lg = $('l-members');
    for (const [name, color] of [[T.joins, c1], [T.leaves, c2]]) { const s = html('span', null, null, lg); html('i', null, null, s).style.background = color; s.appendChild(document.createTextNode(name)); }
    lines($('c-members'), [{ name: T.joins, color: c1, values: col('joins') }, { name: T.leaves, color: c2, values: col('leaves') }], labels);
    $('h-hours').textContent = T.hours;
    columns($('c-hours'), d.hours, d.hours.map((_, h) => `${String(h).padStart(2, '0')}:00`), 3, T.messages);
    $('h-top').textContent = T.top;
    hbars($('c-top'), d.top.map((x) => ({ name: x.name, value: x.messages })));
    $('h-punish').textContent = `${T.punish} · ${T.d30}`;
    hbars($('c-punish'), Object.entries(d.punish).map(([k, v]) => ({ name: T[`k_${k}`] || k, value: v })).sort((a, b) => b.value - a.value));
    /* the table view: every number of the charts without hovering */
    $('h-table').textContent = `📋 ${T.messages} · ${T.active} · ${T.joins} · ${T.leaves}`;
    const tb = $('t-days');
    const head = html('tr', null, null, tb);
    for (const h of ['', T.messages, T.active, T.joins, T.leaves]) html('th', null, h, head);
    for (let i = labels.length - 1; i >= 0; i -= 1) {
      const r = html('tr', null, null, tb);
      html('td', null, labels[i], r);
      for (const k of ['messages', 'active', 'joins', 'leaves']) html('td', null, fmt(col(k)[i]), r);
    }
    $('b-close').textContent = T.close;
    $('b-close').onclick = () => (tg ? tg.close() : window.close());
    $('loading').hidden = true;
    $('app').hidden = false;
  }

  function fail(message) {
    $('loading').hidden = true;
    $('error').hidden = false;
    $('error').textContent = message || '⚠️';
  }

  if (tg) {
    tg.ready();
    tg.expand();
    document.documentElement.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
  }
  if (!tg || !tg.Serverless || !chat) fail('⚠️');
  else tg.Serverless.call('dash', { chat }, (err, d) => (err ? fail(err.message) : render(d)));
})();

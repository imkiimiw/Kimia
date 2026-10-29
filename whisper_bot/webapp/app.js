// The card maker Mini App. It asks the bot what to draw (endpoint cardData: only the user's own link,
// question or received message), draws the card on a canvas in the user's own Telegram client — so
// Persian, Russian and English text are shaped by real fonts — and sends the finished JPEG back
// (endpoint cardSend); the bot posts it to the user's chat, ready for a Telegram or Instagram story.
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var params = new URLSearchParams(location.search);
  var kind = params.get('k') || 'link';
  var msgId = params.get('id') || '';

  var SIZES = { story: [1080, 1920], post: [1080, 1350], square: [1080, 1080] };
  var THEMES = [
    ['#ff7e5f', '#feb47b'],
    ['#4facfe', '#00c6fb'],
    ['#8e2de2', '#4a00e0'],
    ['#11998e', '#38ef7d'],
    ['#232526', '#5a6170'],
    ['#f857a6', '#ff5858'],
  ];
  var state = { size: 'story', theme: 2, data: null, busy: false };

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('card');
  var ctx = canvas.getContext('2d');
  var FONT = "'Vazirmatn', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  function isRtl(s) {
    var m = /[A-Za-zЀ-ӿ]|[֐-ࣿיִ-ﻼ]/.exec(s || '');
    return !!m && /[֐-ࣿיִ-ﻼ]/.test(m[0]);
  }

  /** Lines of `text` that fit `width` at the current font; long words are broken. */
  function wrap(text, width) {
    var out = [];
    String(text || '').split('\n').forEach(function (para) {
      var line = '';
      para.split(/\s+/).filter(Boolean).forEach(function (word) {
        var next = line ? line + ' ' + word : word;
        if (ctx.measureText(next).width <= width) { line = next; return; }
        if (line) out.push(line);
        line = word;
        while (ctx.measureText(line).width > width && line.length > 1) {
          var cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut -= 1;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      });
      out.push(line);
    });
    return out;
  }

  /** Lines of `text` at the largest font ≤ `size` that fits `maxHeight` (not drawn yet). */
  function layout(text, width, maxHeight, size, weight) {
    var lines = [];
    var lh = 0;
    var s = size;
    for (; s >= 24; s -= 2) {
      ctx.font = weight + ' ' + s + 'px ' + FONT;
      lh = Math.round(s * 1.45);
      lines = wrap(text, width);
      if (lines.length * lh <= maxHeight) break;
    }
    lines = lines.slice(0, Math.max(1, Math.floor(maxHeight / lh)));
    return { text: text, lines: lines, lh: lh, size: s, weight: weight, height: lines.length * lh, rtl: isRtl(text) };
  }

  /** Draws a layout centered in [x, x + width] from `y`. */
  function paint(l, x, y, width, color) {
    ctx.font = l.weight + ' ' + l.size + 'px ' + FONT;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.direction = l.rtl ? 'rtl' : 'ltr';
    l.lines.forEach(function (line, i) { ctx.fillText(line, x + width / 2, y + i * l.lh); });
    return l.height;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawQr(text, x, y, size) {
    if (typeof qrcode !== 'function' || !text) return;
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var cell = Math.floor(size / (n + 2));
    var off = (size - cell * n) / 2;
    ctx.fillStyle = '#ffffff';
    roundRect(x, y, size, size, 24);
    ctx.fill();
    ctx.fillStyle = '#111111';
    for (var r = 0; r < n; r += 1) {
      for (var c = 0; c < n; c += 1) if (qr.isDark(r, c)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
    }
  }

  function draw() {
    var d = state.data;
    if (!d) return;
    var wh = SIZES[state.size];
    var W = wh[0];
    var H = wh[1];
    canvas.width = W;
    canvas.height = H;
    var th = THEMES[state.theme];
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, th[0]);
    g.addColorStop(1, th[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // soft decorative circles
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(W * 0.85, H * 0.12, W * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.1, H * 0.9, W * 0.32, 0, Math.PI * 2); ctx.fill();

    var pad = 80;
    var inner = W - pad * 2 - 120; // text width inside the bubble
    var GAP = 44;
    var withQr = d.kind !== 'msg' && !!d.link;
    var qrSize = withQr ? (state.size === 'square' ? 200 : state.size === 'post' ? 240 : 300) : 0;
    var answer = d.kind === 'msg' ? ($('answer').value || '').trim() : '';

    // Everything outside the bubble first, so the bubble gets the rest.
    var head = layout(d.head, W - pad * 2, 200, 64, '700');
    var who = d.name ? layout(d.name + (d.rating ? '  ·  ' + d.rating : ''), W - pad * 2, 60, 34, '400') : null;
    var link = withQr ? layout(d.link.replace(/^https:\/\//, ''), W - pad * 2, 50, 30, '700') : null;
    var foot = layout(d.foot, W - pad * 2, 50, 30, '400');
    var brand = d.brand ? layout(d.brand, W - pad * 2, 46, 28, '400') : null;
    brand && (brand.rtl = false);
    var outside = head.height + (who ? 16 + who.height : 0) + GAP * 2 + (withQr ? qrSize + 20 + link.height + 16 : 0) + foot.height + (brand ? 8 + brand.height : 0);
    var room = H - (state.size === 'story' ? 300 : 140) - outside - 120; // bubble padding: 60 + 60

    var q = d.q && d.kind === 'msg' ? layout('❓ ' + d.q, inner, Math.min(150, room * 0.25), 36, '400') : null;
    var ans = answer ? layout(answer, inner - 80, Math.min(260, room * 0.35), 46, '700') : null;
    var mainRoom = room - (q ? q.height + 24 : 0) - (ans ? ans.height + 60 + 30 : 0);
    var main = layout(d.text || '…', inner, Math.max(80, mainRoom), state.size === 'story' ? 86 : 72, '700');
    var bubbleH = 120 + (q ? q.height + 24 : 0) + main.height + (ans ? ans.height + 60 + 30 : 0);

    var total = outside + bubbleH;
    var y = Math.max(state.size === 'story' ? 150 : 70, (H - total) / 2);
    y += paint(head, pad, y, W - pad * 2, '#ffffff');
    if (who) y += 16 + paint(who, pad, y + 16, W - pad * 2, 'rgba(255,255,255,0.92)');
    y += GAP;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = '#ffffff';
    roundRect(pad, y, W - pad * 2, bubbleH, 48);
    ctx.fill();
    ctx.restore();
    var by = y + 60;
    if (q) by += paint(q, pad + 60, by, inner, '#6b6b78') + 24;
    by += paint(main, pad + 60, by, inner, '#1d1d24');
    if (ans) {
      by += 30;
      ctx.fillStyle = th[0];
      roundRect(pad + 40, by, W - pad * 2 - 80, ans.height + 60, 32);
      ctx.fill();
      paint(ans, pad + 80, by + 30, inner - 80, '#ffffff');
    }
    y += bubbleH + GAP;

    if (withQr) {
      drawQr(d.link, (W - qrSize) / 2, y, qrSize);
      y += qrSize + 20;
      y += paint(link, pad, y, W - pad * 2, '#ffffff') + 16;
    }
    y += paint(foot, pad, y, W - pad * 2, 'rgba(255,255,255,0.9)');
    if (brand) paint(brand, pad, y + 8, W - pad * 2, 'rgba(255,255,255,0.75)');
  }

  function buttons() {
    var L = state.data.labels;
    var sizes = $('sizes');
    sizes.innerHTML = '';
    [['story', L.story], ['post', L.post], ['square', L.square]].forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = s[1];
      b.setAttribute('aria-pressed', String(state.size === s[0]));
      b.onclick = function () { state.size = s[0]; buttons(); draw(); };
      sizes.appendChild(b);
    });
    var themes = $('themes');
    themes.innerHTML = '';
    THEMES.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.title = L.theme + ' ' + (i + 1);
      b.style.background = 'linear-gradient(135deg,' + t[0] + ',' + t[1] + ')';
      b.setAttribute('aria-pressed', String(state.theme === i));
      b.onclick = function () { state.theme = i; buttons(); draw(); };
      themes.appendChild(b);
    });
  }

  function status(text) { $('status').textContent = text || ''; }

  function call(name, input, cb) {
    if (!tg || !tg.Serverless || typeof tg.Serverless.call !== 'function') { cb({ message: 'not in Telegram' }); return; }
    tg.Serverless.call(name, input, cb);
  }

  function send() {
    if (state.busy || !state.data) return;
    var L = state.data.labels;
    state.busy = true;
    $('send').disabled = true;
    status(L.sending);
    draw();
    var image = canvas.toDataURL('image/jpeg', 0.9);
    call('cardSend', { k: kind, id: msgId, image: image }, function (err) {
      state.busy = false;
      $('send').disabled = false;
      if (err) { status(L.failed); if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('error'); return; }
      status(L.sent);
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    });
  }

  function start(data) {
    state.data = data;
    var L = data.labels;
    document.documentElement.lang = data.lang;
    document.documentElement.dir = data.lang === 'fa' ? 'rtl' : 'ltr';
    $('title').textContent = L.title;
    $('send').textContent = L.send;
    $('send').disabled = false;
    $('send').onclick = send;
    var answer = $('answer');
    if (data.kind === 'msg') {
      answer.hidden = false;
      answer.placeholder = L.answer;
      answer.oninput = draw;
    }
    buttons();
    var ready = document.fonts && document.fonts.load ? Promise.all([
      document.fonts.load("700 64px 'Vazirmatn'", 'سلام abc'),
      document.fonts.load("400 34px 'Vazirmatn'", 'سلام abc'),
    ]) : Promise.resolve();
    ready.then(draw, draw);
  }

  if (tg) { tg.ready(); tg.expand(); }
  call('cardData', { k: kind, id: msgId }, function (err, data) {
    if (err || !data) { status(err && err.message ? err.message : 'error'); return; }
    start(data);
  });

  window.__card = { draw: draw, state: state }; // for the automated test
})();

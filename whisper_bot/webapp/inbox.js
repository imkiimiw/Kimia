// The inbox Mini App: the user's anonymous messages on one page — folders, categories, search,
// reading, reactions, replies, archive, category, block, report, delete — through the bot's `inbox`
// endpoint (tgcloud/endpoints/inbox.js), which only ever returns the caller's own messages. Labels
// come from the bot in the user's language. Every text from a message is set with textContent, never
// as HTML, so a message can't put markup or scripts on the page.
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var state = { folder: 0, cat: '-', page: 0, q: '', items: [], more: false, data: null, open: null, busy: false };
  var L = {};
  var searchTimer = null;

  function call(op, input, cb) {
    if (!tg || !tg.Serverless || typeof tg.Serverless.call !== 'function') { cb({ message: 'Open this from the bot' }); return; }
    var body = { op: op };
    Object.keys(input || {}).forEach(function (k) { body[k] = input[k]; });
    tg.Serverless.call('inbox', body, cb);
  }

  function haptic(kind) {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(kind);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(text, onClick, cls) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.onclick = onClick;
    return b;
  }

  function setStatus(id, text) { $(id).textContent = text || ''; }

  // ---------- the list ----------

  function load(reset) {
    if (state.busy) return;
    if (reset) { state.page = 0; state.items = []; }
    state.busy = true;
    call('list', { folder: state.folder, cat: state.cat, page: state.page, q: state.q }, function (err, r) {
      state.busy = false;
      if (err || !r) { setStatus('status', (err && err.message) || L.failed || 'error'); return; }
      state.data = r;
      L = r.labels;
      document.documentElement.lang = r.lang;
      document.documentElement.dir = r.lang === 'fa' ? 'rtl' : 'ltr';
      state.items = state.items.concat(r.items);
      state.more = r.more;
      setStatus('status', '');
      render();
    });
  }

  function render() {
    var d = state.data;
    $('title').textContent = L.title;
    $('search').placeholder = L.search;
    var tabs = $('folders');
    tabs.textContent = '';
    [[0, L.inbox], [1, L.archive], [2, L.filtered]].forEach(function (f) {
      var b = button(f[1] + (f[0] === 0 && d.unread ? ' (' + d.unread + ')' : ''), function () { state.folder = f[0]; load(true); });
      b.setAttribute('aria-pressed', String(state.folder === f[0]));
      tabs.appendChild(b);
    });
    var cats = $('cats');
    cats.textContent = '';
    var all = button(L.all, function () { state.cat = '-'; load(true); });
    all.setAttribute('aria-pressed', String(state.cat === '-'));
    cats.appendChild(all);
    d.cats.forEach(function (c) {
      var b = button(c.label, function () { state.cat = c.key; load(true); });
      b.setAttribute('aria-pressed', String(state.cat === c.key));
      cats.appendChild(b);
    });
    var list = $('list');
    list.textContent = '';
    state.items.forEach(function (m) {
      var li = el('li', m.unread ? 'unread' : '');
      li.dataset.id = m.id;
      var b = button('', function () { openMessage(m.id); });
      var top = el('div', 'top');
      top.appendChild(el('span', 'from', m.from + (m.reaction ? ' · ' + m.reaction : '')));
      top.appendChild(el('span', 'ago', m.ago));
      b.appendChild(top);
      if (m.q) b.appendChild(el('div', 'meta', L.question.replace('{q}', m.q)));
      b.appendChild(el('div', 'preview', m.preview));
      li.appendChild(b);
      list.appendChild(li);
    });
    $('empty').hidden = state.items.length > 0;
    $('empty').textContent = L.empty;
    $('more').hidden = !state.more;
    $('more').textContent = L.more;
  }

  // ---------- one message ----------

  function showView(on) {
    $('app').hidden = on;
    $('view').hidden = !on;
    if (tg && tg.BackButton) {
      if (on) tg.BackButton.show(); else tg.BackButton.hide();
    }
    window.scrollTo(0, 0);
  }

  function openMessage(id) {
    call('get', { id: id }, function (err, m) {
      if (err || !m) { setStatus('status', (err && err.message) || L.failed); return; }
      state.open = m;
      state.items.forEach(function (x) { if (x.id === id) x.unread = false; });
      if (state.data && state.data.unread && state.folder === 0) state.data.unread = Math.max(0, state.data.unread - 1);
      renderView();
      showView(true);
    });
  }

  function renderView() {
    var m = state.open;
    var d = state.data;
    $('back').textContent = '‹ ' + L.back;
    $('vfrom').textContent = m.from + ' · ' + m.ago;
    $('vq').hidden = !m.q;
    $('vq').textContent = m.q ? L.question.replace('{q}', m.q) : '';
    $('vbody').textContent = m.body || '';
    var notes = [];
    if (m.folder === 2) notes.push(L.filtered_note);
    if (m.media) notes.push(L.media_note);
    $('vnote').hidden = !notes.length;
    $('vnote').textContent = notes.join(' ');
    var react = $('vreact');
    react.textContent = '';
    d.reactions.forEach(function (e, i) {
      var b = button(e, function () { act('react', i); });
      b.setAttribute('aria-pressed', String(m.reaction === e));
      react.appendChild(b);
    });
    $('rtext').placeholder = L.reply_ph;
    $('rsend').textContent = L.send;
    var actions = $('vactions');
    actions.textContent = '';
    actions.appendChild(button(m.folder === 0 ? L.to_archive : L.to_inbox, function () { act('archive'); }));
    actions.appendChild(button(L.cat, function () { $('vcats').hidden = !$('vcats').hidden; }));
    actions.appendChild(button(m.blocked ? L.unblock : L.block, function () { act('block'); }));
    actions.appendChild(button(L.open_chat, function () { act('open'); }));
    actions.appendChild(button(L.report, function () { confirmThen(L.report_confirm, function () { act('report'); }); }, 'danger'));
    actions.appendChild(button(L.delete, function () { confirmThen(L.delete_confirm, function () { act('delete'); }); }, 'danger'));
    var cats = $('vcats');
    cats.textContent = '';
    d.pickable.forEach(function (c) {
      var b = button(c.label, function () { cats.hidden = true; act('cat', c.key); });
      b.setAttribute('aria-pressed', String(m.cat === c.key));
      cats.appendChild(b);
    });
    setStatus('vstatus', '');
  }

  function confirmThen(text, then) {
    if (tg && typeof tg.showConfirm === 'function') { tg.showConfirm(text, function (ok) { if (ok) then(); }); return; }
    if (window.confirm(text)) then();
  }

  function act(name, arg) {
    var m = state.open;
    call('act', { id: m.id, act: name, arg: arg }, function (err, r) {
      if (err || !r) { setStatus('vstatus', (err && err.message) || L.failed); haptic('error'); return; }
      haptic('success');
      if (r.deleted) {
        state.items = state.items.filter(function (x) { return x.id !== m.id; });
        closeView(L.deleted);
        return;
      }
      if (r.reported) { setStatus('vstatus', L.reported); return; }
      if (r.opened) { setStatus('vstatus', L.opened_chat); return; }
      if (r.ok && name === 'report') { setStatus('vstatus', L.reported); return; }
      var movedOut = r.folder !== undefined && r.folder !== state.folder;
      state.open = r;
      state.items = state.items.map(function (x) { return x.id === r.id ? r : x; });
      if (movedOut) { state.items = state.items.filter(function (x) { return x.id !== r.id; }); }
      renderView();
      if (name === 'block') setStatus('vstatus', r.blocked ? L.blocked : L.unblocked);
    });
  }

  function sendReply() {
    var m = state.open;
    var text = ($('rtext').value || '').trim();
    if (!text || state.busy) return;
    state.busy = true;
    $('rsend').disabled = true;
    call('reply', { id: m.id, text: text }, function (err) {
      state.busy = false;
      $('rsend').disabled = false;
      if (err) { setStatus('vstatus', err.message || L.failed); haptic('error'); return; }
      $('rtext').value = '';
      setStatus('vstatus', L.sent);
      haptic('success');
    });
  }

  function closeView(note) {
    state.open = null;
    showView(false);
    render();
    setStatus('status', note || '');
  }

  // ---------- start ----------

  $('more').onclick = function () { state.page += 1; load(false); };
  $('back').onclick = function () { closeView(); };
  $('rsend').onclick = sendReply;
  $('search').oninput = function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.q = $('search').value; load(true); }, 400);
  };
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.BackButton) tg.BackButton.onClick(function () { closeView(); });
  }
  load(true);

  window.__inbox = { state: state }; // for the automated test
})();

// The Mini App (no build, no packages): search, popular, favourites, random. Songs can't play here
// (a Telegram file link carries the bot token), so ▶️ sends the song to the chat with the bot.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const status = $('status');
  let tab = 'home';

  if (tg) {
    tg.ready();
    tg.expand();
  }

  function call(input) {
    return new Promise((resolve, reject) => {
      if (!tg || !tg.Serverless) return reject(new Error('Open this page from the bot in Telegram.'));
      tg.Serverless.call('miniApi', input, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 2200);
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  }

  const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

  function show(tracks, empty) {
    list.textContent = '';
    status.textContent = tracks.length ? '' : empty;
    for (const tr of tracks) {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'info';
      const title = document.createElement('b');
      title.textContent = tr.title || '—';
      const meta = document.createElement('span');
      meta.textContent = [tr.artist, mmss(tr.duration)].filter(Boolean).join(' · ');
      info.append(title, meta);
      const play = document.createElement('button');
      play.textContent = '▶️';
      play.title = 'بفرست به چت';
      play.onclick = () => call({ op: 'send', id: tr.id }).then((r) => toast(r.sent ? '🎧 در چت ربات فرستاده شد' : 'این آهنگ دیگر در دسترس نیست')).catch(fail);
      const fav = document.createElement('button');
      fav.textContent = '❤️';
      fav.title = 'علاقه‌مندی';
      fav.onclick = () => call({ op: 'fav', id: tr.id }).then((r) => toast(r.on ? '❤️ به علاقه‌مندی‌ها اضافه شد' : 'از علاقه‌مندی‌ها حذف شد')).catch(fail);
      li.append(info, play, fav);
      list.append(li);
    }
  }

  function gate(res) {
    $('gate').hidden = !res.gate;
    if (!res.gate) return false;
    list.textContent = '';
    status.textContent = '';
    const box = $('channels');
    box.textContent = '';
    for (const c of res.channels || []) {
      const a = document.createElement('button');
      a.textContent = `📢 ${c.title}`;
      a.onclick = () => (tg ? tg.openTelegramLink(c.url) : window.open(c.url));
      box.append(a);
    }
    return true;
  }

  function fail(e) {
    status.textContent = (e && e.message) || 'خطا؛ دوباره امتحان کن.';
  }

  function load(input, empty) {
    status.textContent = 'در حال بارگذاری…';
    return call(input).then((res) => {
      if (gate(res)) return;
      if (res.error === 'too_fast') return fail({ message: 'کمی آرام‌تر 🙂' });
      show(res.tracks || res.popular || [], empty);
    }).catch(fail);
  }

  const tabs = {
    home: () => load({ op: 'home' }, 'هنوز آهنگی نیست.'),
    favs: () => load({ op: 'favs' }, 'هنوز علاقه‌مندی نداری. روی ❤️ هر آهنگ بزن.'),
    random: () => load({ op: 'random' }, 'هنوز آهنگی نیست.'),
  };

  for (const b of document.querySelectorAll('nav button')) {
    b.onclick = () => {
      for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
      tab = b.dataset.tab;
      $('q').value = '';
      tabs[tab]();
    };
  }
  $('search').onsubmit = (e) => {
    e.preventDefault();
    const q = $('q').value.trim();
    if (!q) return tabs[tab]();
    load({ op: 'search', q }, `برای «${q}» چیزی پیدا نشد. از چت ربات می‌توانی درخواستش را بدهی.`);
    $('q').blur();
  };
  $('recheck').onclick = () => tabs[tab]();
  tabs.home();
})();

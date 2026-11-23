// Aegis's landing page: fills every [data-s] element from window.AEGIS_SITE (site-strings.js) in the
// chosen language and builds the add-to-group / add-to-channel links from the URL fragment.
(function () {
  const S = window.AEGIS_SITE || {};
  const LANGS = ['fa', 'en', 'ru', 'zh', 'fr'];
  const tg = window.Telegram && window.Telegram.WebApp;
  const hash = new URLSearchParams(location.hash.slice(1));
  const BOT = /^[A-Za-z0-9_]{5,32}$/.test(hash.get('bot') || '') ? hash.get('bot') : '';
  const RIGHTS = /^[a-z_+]{1,200}$/;

  function pickLang() {
    const wanted = [hash.get('lang'), tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code, navigator.language];
    for (const w of wanted) {
      const l = String(w || '').toLowerCase().slice(0, 2);
      if (LANGS.includes(l) && S[l]) return l;
    }
    return 'en';
  }

  function link(id, url) {
    const a = document.getElementById(id);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
  }

  function render(lang) {
    const d = S[lang] || S.en || {};
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    document.title = d.title || 'Aegis';
    for (const el of document.querySelectorAll('[data-s]')) el.textContent = d[el.dataset.s] || '';
    for (const b of document.querySelectorAll('#langs button')) b.classList.toggle('on', b.dataset.l === lang);
  }

  const nav = document.getElementById('langs');
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.l = l;
    b.textContent = (S[l] && S[l].lang_name) || l;
    b.addEventListener('click', () => {
      hash.set('lang', l);
      history.replaceState(null, '', `#${hash.toString()}`);
      render(l);
    });
    nav.appendChild(b);
  }

  if (BOT) {
    const g = RIGHTS.test(hash.get('g') || '') ? `&admin=${hash.get('g')}` : '';
    const c = RIGHTS.test(hash.get('c') || '') ? `&admin=${hash.get('c')}` : '';
    link('a-group', `https://t.me/${BOT}?startgroup=aegis${g}`);
    link('a-channel', `https://t.me/${BOT}?startchannel${c}`);
    link('a-open', `https://t.me/${BOT}`);
  } else {
    document.getElementById('cta').hidden = true;
    document.getElementById('no-bot').hidden = false;
  }

  render(pickLang());
  if (tg) {
    tg.ready();
    tg.expand();
  }
})();

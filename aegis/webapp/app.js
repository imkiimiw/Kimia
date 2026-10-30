/*
 * Live broadcast page (owner only). While this page is open and visible, it asks the bcLive
 * endpoint for one batch about once a second — that is what keeps a large broadcast moving on a
 * platform without a scheduler. No UI text is hardcoded: every label comes from the endpoint.
 */
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var data = null;
  var busy = false;
  var stopped = false;

  function render(d) {
    data = d;
    var L = d.labels;
    document.documentElement.lang = d.lang;
    document.documentElement.dir = d.rtl ? 'rtl' : 'ltr';
    $('loading').hidden = true;
    $('app').hidden = false;
    $('l-sent').textContent = L.sent;
    $('l-failed').textContent = L.failed;
    $('l-blocked').textContent = L.blocked;
    $('l-left').textContent = L.left;
    $('b-close').textContent = L.close;
    $('b-cancel').textContent = L.cancel;
    var b = d.bc;
    if (!b) {
      $('title').textContent = L.title;
      $('meta').textContent = L.idle;
      $('pct').textContent = '';
      $('fill').style.width = '0';
      ['v-sent', 'v-failed', 'v-blocked', 'v-left'].forEach(function (id) { $(id).textContent = '–'; });
      $('note').textContent = '';
      $('b-toggle').hidden = true;
      $('b-cancel').hidden = true;
      return;
    }
    $('title').textContent = L.title + ' #' + b.f.id + ' — ' + b.statusLabel;
    $('meta').textContent = L.audience + ': ' + b.audienceLabel + ' · ' + L.mode + ': ' + b.modeLabel;
    $('fill').style.width = b.pct + '%';
    $('pct').textContent = b.f.pct + '%';
    $('v-sent').textContent = b.f.sent;
    $('v-failed').textContent = b.f.failed;
    $('v-blocked').textContent = b.f.blocked;
    $('v-left').textContent = b.f.left + ' / ' + b.f.total;
    var note = '';
    if (b.status === 'running') note = b.waitLabel ? L.wait + ' ' + b.waitLabel : L.hint;
    if (b.status === 'paused' && b.lastError === 'source_gone') note = L.paused_source_gone;
    if (b.tookLabel && (b.status === 'done' || b.status === 'cancelled')) note = b.tookLabel;
    $('note').textContent = note;
    var live = b.status === 'running' || b.status === 'paused';
    $('b-toggle').hidden = !live;
    $('b-cancel').hidden = !live && b.status !== 'queued';
    $('b-toggle').textContent = b.status === 'paused' ? L.resume : L.pause;
  }

  function call(action) {
    return new Promise(function (resolve, reject) {
      tg.Serverless.call('bcLive', { action: action }, function (err, result) {
        if (err) reject(err); else resolve(result);
      });
    });
  }

  function act(action) {
    if (busy) return Promise.resolve();
    busy = true;
    return call(action).then(render).catch(function (err) {
      $('loading').hidden = false;
      $('loading').textContent = '⚠️ ' + ((err && err.message) || '');
    }).then(function () { busy = false; });
  }

  function loop() {
    if (stopped) return;
    var visible = document.visibilityState !== 'hidden';
    var running = data && data.bc && data.bc.status === 'running';
    var p = visible ? act(running ? 'tick' : 'status') : Promise.resolve();
    p.then(function () { window.setTimeout(loop, running ? 1100 : 3000); });
  }

  $('b-toggle').onclick = function () {
    if (data && data.bc) act(data.bc.status === 'paused' ? 'resume' : 'pause');
  };
  $('b-cancel').onclick = function () {
    if (!data) return;
    tg.showConfirm(data.labels.cancel_q, function (ok) { if (ok) act('cancel'); });
  };
  $('b-close').onclick = function () { stopped = true; tg.close(); };

  if (!tg || !tg.Serverless) {
    $('loading').textContent = '⚠️';
    return;
  }
  tg.ready();
  tg.expand();
  loop();
}());

/*
 * The join-request captcha (Aegis as the chat's guard bot). Asks the joinGuard endpoint for the
 * question and sends the chosen answer; Telegram's own init data tells the endpoint who is asking.
 */
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  function call(input, done) {
    tg.Serverless.call('joinGuard', input, function (err, res) {
      if (err) {
        $('loading').hidden = true;
        $('app').hidden = false;
        $('result').textContent = err.message || 'Error';
        return;
      }
      done(res);
    });
  }

  function finish(d) {
    $('options').innerHTML = '';
    $('question').textContent = '';
    $('hint').textContent = '';
    $('result').textContent = d.text || '';
    $('b-close').hidden = false;
    setTimeout(function () { tg.close(); }, 2500);
  }

  function render(d) {
    document.documentElement.lang = d.lang;
    document.documentElement.dir = d.rtl ? 'rtl' : 'ltr';
    $('loading').hidden = true;
    $('app').hidden = false;
    $('title').textContent = d.title;
    $('b-close').textContent = d.close;
    if (d.done) return finish(d);
    $('question').textContent = d.question;
    $('hint').textContent = d.hint;
    var box = $('options');
    box.innerHTML = '';
    (d.options || []).forEach(function (o, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o;
      b.onclick = function () {
        if (busy) return;
        busy = true;
        call({ action: 'answer', choice: i }, function (r) {
          busy = false;
          if (r.done) return finish(r);
          $('result').textContent = r.text;
        });
      };
      box.appendChild(b);
    });
  }

  if (!tg) return;
  tg.ready();
  tg.expand();
  $('b-close').onclick = function () { tg.close(); };
  call({ action: 'get' }, render);
})();

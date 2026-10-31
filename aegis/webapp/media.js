/*
 * Reads text (OCR) and QR codes in a photo, here on the member's device: the media endpoint gives the
 * photo of the member's own request (checked against Telegram's signed init data) and can send the
 * text read to their private chat. Tesseract.js downloads its language data from jsDelivr on first use.
 */
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function (id) { return document.getElementById(id); };
  var job = Number(new URLSearchParams(location.search).get('j')) || 0;
  var words = {};
  var busy = false;

  function call(input, done) {
    tg.Serverless.call('media', Object.assign({ job: job }, input), function (err, res) {
      if (err) {
        $('loading').hidden = true;
        $('app').hidden = false;
        $('status').textContent = err.message || 'Error';
        busy = false;
        return;
      }
      done(res);
    });
  }

  function show(text) {
    $('out').hidden = false;
    $('out').value = text;
    $('b-copy').hidden = false;
    $('b-send').hidden = false;
  }

  function imageData() {
    var img = $('photo');
    var c = $('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  }

  function readQr() {
    if (!window.jsQR) return;
    var d = imageData();
    var code = window.jsQR(d.data, d.width, d.height);
    if (code && code.data) {
      $('status').textContent = '';
      show(code.data);
    } else $('status').textContent = words.app_qr_none;
  }

  function readText() {
    if (busy || !window.Tesseract) return;
    busy = true;
    $('status').textContent = words.app_running;
    window.Tesseract.createWorker($('lang').value.split('+'), 1, {
      logger: function (m) { if (m && m.progress) $('status').textContent = words.app_running + ' ' + Math.round(m.progress * 100) + '%'; },
    }).then(function (worker) {
      return worker.recognize($('canvas')).then(function (r) {
        worker.terminate();
        busy = false;
        var text = (r && r.data && r.data.text || '').trim();
        $('status').textContent = text ? '' : words.app_none;
        if (text) show(text);
      });
    }).catch(function (e) {
      busy = false;
      $('status').textContent = String(e && e.message || e);
    });
  }

  if (!tg) return;
  tg.ready();
  tg.expand();
  call({ action: 'get' }, function (d) {
    words = d.text;
    document.documentElement.lang = d.lang;
    document.documentElement.dir = d.rtl ? 'rtl' : 'ltr';
    $('title').textContent = words.app_title;
    $('b-ocr').textContent = words.app_ocr;
    $('b-qr').textContent = words.app_qr;
    $('l-lang').textContent = words.app_lang;
    $('b-copy').textContent = words.app_copy;
    $('b-send').textContent = words.app_send;
    $('note').textContent = words.app_note;
    $('lang').value = d.ocrLang;
    $('photo').onload = function () {
      imageData();
      $('loading').hidden = true;
      $('app').hidden = false;
    };
    $('photo').src = 'data:' + d.mime + ';base64,' + d.image;
  });
  $('b-ocr').onclick = readText;
  $('b-qr').onclick = readQr;
  $('b-copy').onclick = function () {
    $('out').select();
    try { document.execCommand('copy'); } catch (e) { /* not allowed here */ }
    $('status').textContent = words.app_copied;
  };
  $('b-send').onclick = function () {
    call({ action: 'send', text: $('out').value }, function (r) { $('status').textContent = r.text; });
  };
})();

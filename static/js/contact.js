/* Connect page: sends the visitor's message to Darshan's Gmail via FormSubmit (no backend needed). */
(function () {
  'use strict';

  var EMAIL = 'connect.darshanparmar@gmail.com';
  var ENDPOINT = 'https://formsubmit.co/ajax/' + EMAIL;
  var COOLDOWN_MS = 30 * 1000;
  var LAST_KEY = 'infiniteContactLastSent';
  var MAX = 2000;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('cn-form'), nameEl = $('cn-name-in'), mailEl = $('cn-email-in'), msgEl = $('cn-msg-in');
  var sendBtn = $('cn-send'), statusEl = $('cn-status'), countEl = $('cn-count'), hp = $('cn-hp');
  // top-bar UTC clock (same format as the other pages)
  function tick() {
    var n = new Date(), c = $('utc-clock'), p = function (v) { return String(v).padStart(2, '0'); };
    if (c) c.textContent = p(n.getUTCHours()) + ':' + p(n.getUTCMinutes()) + ':' + p(n.getUTCSeconds()) + ' UTC';
  }
  tick(); setInterval(tick, 1000);

  if (!form) return;

  function setStatus(kind, html) {
    statusEl.className = 'cn-status show ' + kind;
    statusEl.innerHTML = '<i class="fa-solid ' + (kind === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation') + '"></i><span>' + html + '</span>';
  }
  function clearStatus() { statusEl.className = 'cn-status'; statusEl.innerHTML = ''; }
  function mark(el, bad) { el.closest('.cn-field').classList.toggle('bad', !!bad); }

  // prefill the name from a signed-in profile if the page already knows it
  setTimeout(function () {
    var n = $('user-name');
    if (n && !nameEl.value && n.textContent && n.textContent.trim() !== 'Guest') nameEl.value = n.textContent.trim();
  }, 900);

  var sidebarAvatar = $('user-initial'), developerAvatar = $('cn-avatar');
  function syncDeveloperAvatar() {
    if (!sidebarAvatar || !developerAvatar) return;
    var avatarStyle = getComputedStyle(sidebarAvatar);
    developerAvatar.textContent = sidebarAvatar.textContent;
    developerAvatar.style.backgroundImage = avatarStyle.backgroundImage;
    developerAvatar.style.backgroundSize = avatarStyle.backgroundSize;
    developerAvatar.style.backgroundPosition = avatarStyle.backgroundPosition;
    developerAvatar.style.color = avatarStyle.color;
  }
  if (sidebarAvatar && developerAvatar) {
    syncDeveloperAvatar();
    new MutationObserver(syncDeveloperAvatar).observe(sidebarAvatar, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    document.addEventListener('lifeIsShortAuthState', syncDeveloperAvatar);
    document.addEventListener('lifeIsShortProfileReady', syncDeveloperAvatar);
  }

  msgEl.addEventListener('input', function () {
    countEl.textContent = msgEl.value.length + ' / ' + MAX;
    mark(msgEl, false);
  });
  nameEl.addEventListener('input', function () { mark(nameEl, false); });
  mailEl.addEventListener('input', function () { mark(mailEl, false); });

  // copy email
  var copyBtn = $('cn-copy');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var done = function () {
      copyBtn.classList.add('done'); copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
      setTimeout(function () { copyBtn.classList.remove('done'); copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(EMAIL).then(done, function () {});
    else done();
  });

  function mailtoFallback(name, email, msg) {
    var body = msg + '\n\n— ' + name + ' (' + email + ')';
    return 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('Hello from ' + name + ' (via Infinite)') + '&body=' + encodeURIComponent(body);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearStatus();
    if (hp.value) return; // bot

    var name = nameEl.value.trim(), email = mailEl.value.trim(), msg = msgEl.value.trim();
    var okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    mark(nameEl, !name); mark(mailEl, !okEmail); mark(msgEl, msg.length < 3);
    if (!name || !okEmail || msg.length < 3) {
      setStatus('err', 'Please add your name, a valid email and a short message.');
      return;
    }

    var last = 0;
    try { last = +localStorage.getItem(LAST_KEY) || 0; } catch (_) {}
    var wait = COOLDOWN_MS - (Date.now() - last);
    if (wait > 0) { setStatus('err', 'Message already sent. You can send another in ' + Math.ceil(wait / 1000) + 's.'); return; }

    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>Sending…';

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        name: name,
        email: email,
        message: msg.slice(0, MAX),
        _subject: 'Infinite: new message from ' + name,
        _replyto: email,
        _template: 'table',
        _captcha: 'false',
        page: location.href
      })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || res.j.success === 'false' || res.j.success === false) throw new Error(res.j.message || 'send failed');
        try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (_) {}
        form.reset(); countEl.textContent = '0 / ' + MAX;
        setStatus('ok', 'Thanks, ' + name.replace(/</g, '&lt;') + '! Your message is on its way to Darshan.');
      })
      .catch(function () {
        setStatus('err', 'Could not send right now. <a href="' + mailtoFallback(name, email, msg).replace(/"/g, '&quot;') + '">Open it in your email app instead</a>.');
      })
      .then(function () {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>Send message';
      });
  });
})();

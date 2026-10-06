/* Connect page.
 *
 * A message goes two places: into Firestore, so it shows up in the inbox on this page, and out
 * by email through FormSubmit, which needs a one-time "Activate Form" click before it delivers.
 * Either one failing on its own is fine, which is why both are tracked separately.
 */
(function () {
  'use strict';

  var EMAIL = 'connect.darshanparmar@gmail.com';
  var ADMIN_EMAIL = 'parmardarshan918@gmail.com'; // the account that can open the admin inbox (EMAIL above stays the public contact address)
  var ENDPOINT = 'https://formsubmit.co/ajax/' + EMAIL;
  var COLLECTION = 'contactMessages';
  var COOLDOWN_MS = 30 * 1000;
  var LAST_KEY = 'infiniteContactLastSent';
  var MAX = 2000;
  var INBOX_LIMIT = 50;
  var MINE_KEY = 'infiniteContactMine';

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
  /* Developer card photo.
   * The admin account's profile photo is published to a public doc (publicProfile/developer) whenever the
   * admin opens this page, so every visitor sees it. Nobody else's photo is ever used here. */
  var publicPhoto = null;            // null = still loading, '' = none published
  function sidebarPhoto() {
    var m = /^url\(["']?(.*?)["']?\)$/.exec(getComputedStyle(sidebarAvatar).backgroundImage || '');
    return m ? m[1] : '';
  }
  function paintDeveloper(url) {
    developerAvatar.textContent = url ? '' : 'D';
    developerAvatar.style.backgroundImage = url ? 'url("' + url + '")' : '';
    developerAvatar.style.backgroundSize = url ? 'cover' : '';
    developerAvatar.style.backgroundPosition = url ? 'center' : '';
  }
  function publishPhoto(url) {
    if (publicPhoto === url) return;
    var before = publicPhoto;
    publicPhoto = url;
    withDb(function (db) {
      return db.collection('publicProfile').doc('developer').set({
        photo: url,
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
      });
    }).catch(function () { publicPhoto = before; });
  }
  function syncDeveloperAvatar(ev) {
    if (!sidebarAvatar || !developerAvatar) return;
    if (isOwner()) {
      var url = sidebarPhoto();
      if (url) {
        paintDeveloper(url);
        if (publicPhoto !== null) publishPhoto(url);           // only writes when it changed
        return;
      }
      // profile finished loading and the admin has no photo: clear the public one
      if (ev && ev.type === 'lifeIsShortProfileReady' && publicPhoto) publishPhoto('');
    }
    paintDeveloper(publicPhoto || '');
  }
  function loadPublicPhoto() {
    withDb(function (db) { return db.collection('publicProfile').doc('developer').get(); })
      .then(function (snap) { publicPhoto = snap.exists && snap.data().photo ? snap.data().photo : ''; })
      .catch(function () { publicPhoto = ''; })
      .then(function () { syncDeveloperAvatar(); });
  }
  if (sidebarAvatar && developerAvatar) {
    loadPublicPhoto();
    new MutationObserver(function () { syncDeveloperAvatar(); }).observe(sidebarAvatar, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    document.addEventListener('lifeIsShortAuthState', syncDeveloperAvatar);
    document.addEventListener('lifeIsShortProfileReady', syncDeveloperAvatar);
    setTimeout(syncDeveloperAvatar, 1500);
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

  /* ---------- firestore, when it is ready ---------- */
  // auth.js creates the app and the database handle after its own scripts load, so the first
  // paint can arrive before either exists.
  // auth.js declares its handles with `let`, so they are NOT on window. Use the firebase SDK directly.
  function getDb() {
    try { return window.firebase && firebase.apps && firebase.apps.length ? firebase.firestore() : null; } catch (_) { return null; }
  }
  function withDb(fn, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var step = function () {
        var db = getDb();
        if (db) { try { resolve(fn(db)); return; } catch (e) { reject(e); return; } }
        if (waited >= (timeoutMs || 12000)) { reject(new Error('Firestore is not ready')); return; }
        waited += 250;
        setTimeout(step, 250);
      };
      step();
    });
  }
  function me() { try { return window.firebase && firebase.apps && firebase.apps.length ? firebase.auth().currentUser : null; } catch (_) { return null; } }
  function isOwner() { var u = me(); return !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL); }

  function storeMessage(name, email, msg) {
    return withDb(function (db) {
      var data = {
        name: name,
        email: email,
        message: msg.slice(0, MAX),
        to: EMAIL,
        read: false,
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      };
      var u = me();
      if (u) data.uid = u.uid;
      return db.collection(COLLECTION).add(data);
    });
  }

  /* ---------- "your sent messages" (visitor side) ---------- */
  var mineBox = $('cn-mine'), mineList = $('cn-mine-list'), mineCount = $('cn-mine-count'), mineEmpty = $('cn-mine-empty');

  function fmtTime(when) {
    if (!when) return '';
    var d = new Date(when), mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
    if (mins < 10080) return Math.floor(mins / 1440) + 'd ago';
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }
  function when(t) { return fmtTime(t && t.toDate ? t.toDate() : t); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Guests have no account to query by, so their sent messages are remembered in this browser.
  function readLocal() { try { return JSON.parse(localStorage.getItem(MINE_KEY) || '[]'); } catch (_) { return []; } }
  function rememberLocal(name, email, msg) {
    var a = readLocal(); a.unshift({ name: name, email: email, message: msg.slice(0, MAX), createdAt: Date.now() });
    try { localStorage.setItem(MINE_KEY, JSON.stringify(a.slice(0, 30))); } catch (_) {}
  }

  var mineItems = [];
  function renderMine(items) {
    mineItems = items;
    mineCount.textContent = String(items.length);
    mineEmpty.hidden = items.length > 0;
    mineList.innerHTML = items.map(function (m, i) {
      var edited = m.editedAt ? ' · edited' : '';
      var acts = m.id
        ? '<div class="cn-msg-acts">' +
          '<button type="button" class="cn-act" data-act="edit"><i class="fa-regular fa-pen-to-square"></i> Edit</button>' +
          '<button type="button" class="cn-act cn-act-del" data-act="del"><i class="fa-regular fa-trash-can"></i> Delete</button></div>'
        : '<span class="cn-msg-mail">Sign in to edit or delete messages you send.</span>';
      return '<div class="cn-msg" data-i="' + i + '">' +
        '<button type="button" class="cn-msg-top" aria-expanded="false">' +
        '<span class="cn-msg-av"><i class="fa-solid fa-paper-plane"></i></span>' +
        '<span class="cn-msg-who"><span class="cn-msg-name">To Darshan Parmar</span>' +
        '<span class="cn-msg-when">' + esc(when(m.createdAt)) + esc(edited) + '</span></span>' +
        '<span class="cn-msg-spacer"></span>' +
        '<span class="cn-msg-tag">SENT</span>' +
        '<i class="fa-solid fa-chevron-down cn-msg-caret"></i></button>' +
        '<div class="cn-msg-body"><p class="cn-msg-text">' + esc(m.message) + '</p>' +
        '<div class="cn-msg-edit" hidden><textarea maxlength="' + MAX + '" aria-label="Edit your message"></textarea>' +
        '<div class="cn-msg-acts"><button type="button" class="cn-act cn-act-save" data-act="save"><i class="fa-solid fa-check"></i> Save</button>' +
        '<button type="button" class="cn-act" data-act="cancel">Cancel</button></div>' +
        '<div class="cn-msg-err" role="alert"></div></div>' +
        acts +
        '<span class="cn-msg-mail">Replies go to ' + esc(m.email) + '</span></div></div>';
    }).join('');
  }

  function loadMine() {
    var u = me();
    if (!u) { renderMine(readLocal()); return Promise.resolve(); }
    return withDb(function (db) {
      return db.collection(COLLECTION).where('uid', '==', u.uid).limit(INBOX_LIMIT).get();
    }).then(function (snap) {
      var items = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      items.sort(function (a, b) {
        var x = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        var y = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return y - x;
      });
      renderMine(items);
    }).catch(function () { renderMine(readLocal()); });
  }

  if (mineList) {
    mineList.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      var row = e.target.closest('.cn-msg');
      if (btn && row) {
        var m = mineItems[+row.getAttribute('data-i')];
        var act = btn.getAttribute('data-act');
        var view = row.querySelector('.cn-msg-text'), edit = row.querySelector('.cn-msg-edit'), acts = row.querySelector(':scope > .cn-msg-body > .cn-msg-acts');
        var ta = edit.querySelector('textarea'), err = edit.querySelector('.cn-msg-err');
        if (!m || !m.id) return;
        if (act === 'edit') {
          ta.value = m.message || ''; err.textContent = '';
          view.hidden = true; if (acts) acts.hidden = true; edit.hidden = false; ta.focus();
        } else if (act === 'cancel') {
          edit.hidden = true; view.hidden = false; if (acts) acts.hidden = false;
        } else if (act === 'save') {
          var text = ta.value.trim();
          if (text.length < 3) { err.textContent = 'Write at least a few characters.'; return; }
          btn.disabled = true;
          withDb(function (db) {
            return db.collection(COLLECTION).doc(m.id).update({
              message: text.slice(0, MAX),
              editedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
              read: false
            });
          }).then(loadMine).catch(function (x) { btn.disabled = false; err.textContent = 'Could not save: ' + (x && x.message ? x.message : 'error'); });
        } else if (act === 'del') {
          if (!window.confirm('Delete this message? It is removed from the inbox. An email copy that was already sent cannot be taken back.')) return;
          btn.disabled = true;
          withDb(function (db) { return db.collection(COLLECTION).doc(m.id).delete(); })
            .then(loadMine).catch(function (x) { btn.disabled = false; window.alert('Could not delete: ' + (x && x.message ? x.message : 'error')); });
        }
        return;
      }
      var top = e.target.closest('.cn-msg-top');
      if (!top) return;
      var open = top.closest('.cn-msg').classList.toggle('open');
      top.setAttribute('aria-expanded', String(open));
    });
  }

  // the developer gets a shortcut to the admin inbox
  function syncAdminLink() { var l = $('nav-admin'); if (l) l.hidden = !isOwner(); }
  document.addEventListener('lifeIsShortAuthState', function () { syncAdminLink(); loadMine(); });
  document.addEventListener('lifeIsShortProfileReady', syncAdminLink);
  setTimeout(syncAdminLink, 1500);
  loadMine();


  /* ---------- developer box: locked for everyone, opened with the developer key ---------- */
  (function () {
    var card = $('cn-dev-card'), dlg = $('dev-gate');
    if (!card || !dlg || !window.DevKey) return;
    var title = $('dev-gate-title'), text = $('dev-gate-text'), key = $('dev-gate-key'), key2 = $('dev-gate-key2');
    var err = $('dev-gate-err'), ok = $('dev-gate-ok'), icon = $('dev-gate-icon'), gform = $('dev-gate-form');
    var mode = '', cfg = null, tries = 0, blockedUntil = 0;

    function view(m, o) {
      mode = m; err.textContent = '';
      title.textContent = o.title; text.textContent = o.text;
      icon.className = 'fa-solid ' + (o.icon || 'fa-lock');
      key.hidden = !o.key; key2.hidden = !o.key2; key.value = ''; key2.value = '';
      key.placeholder = o.ph || 'Developer key';
      ok.hidden = !o.btn; ok.textContent = o.btn || ''; ok.disabled = false;
      if (o.key) setTimeout(function () { key.focus(); }, 30);
    }

    function openGate() {
      if (!dlg.open) dlg.showModal();
      if (!DevKey.isOwner()) {
        view('denied', { icon: 'fa-hand', title: 'Developer only',
          text: 'This is for the developer only, not for you.' });
        return;
      }
      view('loading', { title: 'Developer box', text: 'Checking…' });
      DevKey.getConfig().then(function (c) {
        cfg = c;
        if (c) view('enter', { key: true, btn: 'Open', title: 'Enter your key', text: 'Enter the developer key to open your messages.' });
        else view('set', { key: true, key2: true, btn: 'Save key and open', ph: 'Choose a key (min ' + DevKey.MIN + ' characters)',
          title: 'Set your key', text: 'You have not set a key yet. Choose one now. You will need it every time you open this box.' });
      }).catch(function (e) {
        view('denied', { icon: 'fa-triangle-exclamation', title: 'Could not open',
          text: 'Could not reach the key store: ' + (e && e.message ? e.message : 'unknown error') });
      });
    }

    function done() { DevKey.unlock(); location.href = '../admin/'; }

    gform.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = '';
      var k = key.value;
      if (mode === 'set') {
        if (k.length < DevKey.MIN) { err.textContent = 'Use at least ' + DevKey.MIN + ' characters.'; return; }
        if (k !== key2.value) { err.textContent = 'The two keys do not match.'; return; }
        ok.disabled = true;
        DevKey.setKey(k).then(done).catch(function (x) { ok.disabled = false; err.textContent = 'Could not save: ' + (x && x.message ? x.message : 'error'); });
      } else if (mode === 'enter') {
        if (Date.now() < blockedUntil) { err.textContent = 'Too many tries. Wait ' + Math.ceil((blockedUntil - Date.now()) / 1000) + 's.'; return; }
        if (!k) { err.textContent = 'Enter your key.'; return; }
        ok.disabled = true;
        DevKey.verify(k, cfg).then(function (good) {
          if (good) { done(); return; }
          ok.disabled = false; key.value = ''; key.focus();
          if (++tries >= 5) { tries = 0; blockedUntil = Date.now() + 30000; err.textContent = 'Wrong key. Locked for 30s.'; }
          else err.textContent = 'Wrong key.';
        }).catch(function () { ok.disabled = false; err.textContent = 'Could not check the key.'; });
      }
    });

    $('dev-gate-close').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });

    // Opened from a notification: team-notify.js sends the bell here, and this page opens the gate.
    document.addEventListener('infiniteOpenDevGate', openGate);
    setTimeout(function () {
      var flag = null;
      try { flag = sessionStorage.getItem('infiniteOpenGate'); sessionStorage.removeItem('infiniteOpenGate'); } catch (_) {}
      if (flag) openGate();
    }, 500);

    // clicking anywhere on the card opens the gate, except its own links and buttons
    card.addEventListener('click', function (e) { if (!e.target.closest('a, button')) openGate(); });
    var navAdmin = $('nav-admin');
    if (navAdmin) navAdmin.addEventListener('click', function (e) { e.preventDefault(); openGate(); });
    card.addEventListener('keydown', function (e) { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGate(); } });
  })();

  function sendByEmail(name, email, msg) {
    return fetch(ENDPOINT, {
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
      .then(function (r) {
        return r.json().catch(function () { return {}; })
          .then(function (j) { return { ok: r.ok, j: j }; });
      })
      .then(function (res) {
        if (!res.ok || res.j.success === 'false' || res.j.success === false) {
          var err = new Error(res.j.message || 'send failed');
          err.reason = res.j.message || '';
          throw err;
        }
      });
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

    var stored = false, emailed = false, mailWhy = '';
    // Firestore first: it is the inbox you asked for, and it does not need activating.
    storeMessage(name, email, msg)
      .then(function () { stored = true; })
      .catch(function () {})
      .then(function () {
        return sendByEmail(name, email, msg)
          .then(function () { emailed = true; })
          .catch(function (err) { mailWhy = (err && err.reason) || (err && err.message) || ''; });
      })
      .then(function () {
        try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (_) {}
        if (stored || emailed) {
          form.reset(); countEl.textContent = '0 / ' + MAX;
          if (!me()) rememberLocal(name, email, msg);
          loadMine();
          var safe = name.replace(/</g, '&lt;');
          if (stored && emailed) setStatus('ok', 'Thanks, ' + safe + '! It is in the inbox below and a copy is on its way by email.');
          else if (stored) setStatus('ok', 'Saved to the inbox. Email is not sending yet'
            + (mailWhy.indexOf('Activation') >= 0 ? ' — open the "Activate Form" email FormSubmit sent you, then it works.' : '.'));
          else setStatus('ok', 'Sent by email. The inbox copy needs Firestore, which was not available.');
        } else {
          setStatus('err', 'Could not save or send right now. <a href="' + mailtoFallback(name, email, msg).replace(/"/g, '&quot;') + '">Open it in your email app instead</a>.');
        }
      })
      .then(function () {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>Send message';
      });
  });
})();
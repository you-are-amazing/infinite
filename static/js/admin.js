/* Admin inbox: every message sent through the Connect form.
 * The page only hides things for non-owners; the real lock is firestore.rules
 * (reads/updates/deletes on contactMessages are limited to the developer's signed-in address).
 */
(function () {
  'use strict';

  var ADMIN_EMAIL = 'parmardarshan918@gmail.com';
  var COLLECTION = 'contactMessages';
  var LIMIT = 200;

  var $ = function (id) { return document.getElementById(id); };
  var lock = $('ad-lock'), lockMsg = $('ad-lock-msg'), box = $('ad-inbox'), list = $('ad-list');
  var countEl = $('ad-count'), unreadEl = $('ad-unread'), emptyEl = $('ad-empty'), searchEl = $('ad-search');
  var items = [], filter = 'all', query = '';

  function tick() {
    var n = new Date(), c = $('utc-clock'), p = function (v) { return String(v).padStart(2, '0'); };
    if (c) c.textContent = p(n.getUTCHours()) + ':' + p(n.getUTCMinutes()) + ':' + p(n.getUTCSeconds()) + ' UTC';
  }
  tick(); setInterval(tick, 1000);

  function getDb() {
    try { return window.firebase && firebase.apps && firebase.apps.length ? firebase.firestore() : null; } catch (_) { return null; }
  }
  function withDb(fn, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      (function step() {
        var db = getDb();
        if (db) { try { resolve(fn(db)); } catch (e) { reject(e); } return; }
        if (waited >= (timeoutMs || 12000)) { reject(new Error('Firestore is not ready')); return; }
        waited += 250; setTimeout(step, 250);
      })();
    });
  }
  function me() { try { return window.firebase && firebase.apps && firebase.apps.length ? firebase.auth().currentUser : null; } catch (_) { return null; } }
  function isOwner() { var u = me(); return !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL); }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); }
  function ms(t) { return t && t.toMillis ? t.toMillis() : (typeof t === 'number' ? t : 0); }
  function fmt(t) {
    var v = ms(t); if (!v) return '';
    var d = new Date(v), mins = Math.floor((Date.now() - v) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
    if (mins < 10080) return Math.floor(mins / 1440) + 'd ago';
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function replyLink(m) {
    var body = 'Hi ' + String(m.name || '').split(' ')[0] + ',\n\n\n---\nOn ' + fmt(m.createdAt) + ', ' + String(m.name || 'someone') + ' wrote:\n\n' + String(m.message || '');
    return 'mailto:' + String(m.email || '').trim() + '?subject=' + encodeURIComponent('Re: your message to Infinite') + '&body=' + encodeURIComponent(body);
  }

  function visible() {
    var q = query.trim().toLowerCase();
    return items.filter(function (m) {
      if (filter === 'unread' && m.read) return false;
      if (!q) return true;
      return (String(m.name) + ' ' + String(m.email) + ' ' + String(m.message)).toLowerCase().indexOf(q) >= 0;
    });
  }

  function render() {
    var unread = items.filter(function (m) { return !m.read; }).length;
    countEl.textContent = String(items.length);
    unreadEl.textContent = String(unread);
    var shown = visible();
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = items.length ? 'No messages match.' : 'Nothing here yet. Anyone who uses the Connect form lands in this list.';
    var openIds = {};
    Array.prototype.forEach.call(list.querySelectorAll('.cn-msg.open'), function (r) { openIds[r.getAttribute('data-id')] = 1; });
    list.innerHTML = shown.map(function (m) {
      var peek = String(m.message || '').replace(/\s+/g, ' ').slice(0, 90);
      var cls = 'cn-msg' + (m.read ? '' : ' unread') + (openIds[m.id] ? ' open' : '');
      return '<div class="' + cls + '" data-id="' + esc(m.id) + '">' +
        '<button type="button" class="cn-msg-top" aria-expanded="' + (openIds[m.id] ? 'true' : 'false') + '">' +
        '<span class="cn-msg-av">' + esc(initials(m.name)) + '</span>' +
        '<span class="cn-msg-who"><span class="cn-msg-name">' + esc(m.name) + '</span>' +
        '<span class="cn-msg-when">' + esc(fmt(m.createdAt) + (m.editedAt ? ' · edited' : '')) + '</span></span>' +
        '<span class="cn-msg-peek">' + esc(peek) + '</span>' +
        '<i class="fa-solid fa-chevron-down cn-msg-caret"></i></button>' +
        '<div class="cn-msg-body"><p class="cn-msg-text">' + esc(m.message) + '</p>' +
        '<a class="cn-msg-reply" href="' + esc(replyLink(m)) + '"><i class="fa-solid fa-reply"></i>Reply by email</a>' +
        '<button type="button" class="ad-del" data-del="' + esc(m.id) + '"><i class="fa-regular fa-trash-can"></i> Delete</button>' +
        '<span class="cn-msg-mail">' + esc(m.email) + '</span></div></div>';
    }).join('');
  }

  function show(owner, text) {
    var l = $('nav-admin'); if (l) l.hidden = !owner;
    box.hidden = !owner;
    lock.hidden = owner;
    if (!owner) lockMsg.innerHTML = text;
  }

  function load() {
    var u = me();
    if (!u) { show(false, 'Sign in with the developer account to see the inbox.'); return Promise.resolve(); }
    if (!isOwner()) { show(false, 'This page is only for the developer of Infinite.'); return Promise.resolve(); }
    if (!window.DevKey || !DevKey.isUnlocked()) {
      show(false, 'This inbox is locked. Open the <b>Developer box</b> on the <a href="../contact/">Connect page</a> and enter your key.');
      return Promise.resolve();
    }
    show(true);
    countEl.textContent = '…';
    return withDb(function (db) {
      return db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(LIMIT).get();
    }).then(function (snap) {
      items = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      render();
    }).catch(function (e) {
      countEl.textContent = '–';
      emptyEl.hidden = false;
      emptyEl.textContent = 'Could not load messages: ' + (e && e.message ? e.message : 'Firestore is unavailable');
    });
  }

  list.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) {
      var id = del.getAttribute('data-del');
      if (!window.confirm('Delete this message for good?')) return;
      withDb(function (db) { return db.collection(COLLECTION).doc(id).delete(); })
        .then(function () { items = items.filter(function (m) { return m.id !== id; }); render(); })
        .catch(function (err) { window.alert('Could not delete: ' + (err && err.message ? err.message : 'unknown error')); });
      return;
    }
    var top = e.target.closest('.cn-msg-top');
    if (!top) return;
    var row = top.closest('.cn-msg');
    var open = row.classList.toggle('open');
    top.setAttribute('aria-expanded', String(open));
    var m = items.filter(function (x) { return x.id === row.getAttribute('data-id'); })[0];
    if (open && m && !m.read) {
      m.read = true; row.classList.remove('unread');
      unreadEl.textContent = String(items.filter(function (x) { return !x.read; }).length);
      withDb(function (db) { return db.collection(COLLECTION).doc(m.id).update({ read: true }); }).catch(function () { m.read = false; });
    }
  });

  Array.prototype.forEach.call(document.querySelectorAll('.ad-tab'), function (b) {
    b.addEventListener('click', function () {
      filter = b.getAttribute('data-f');
      Array.prototype.forEach.call(document.querySelectorAll('.ad-tab'), function (x) { x.classList.toggle('on', x === b); });
      render();
    });
  });
  searchEl.addEventListener('input', function () { query = searchEl.value; render(); });

  var relock = $('ad-relock');
  if (relock) relock.addEventListener('click', function () { DevKey.lock(); location.href = '../contact/'; });

  var kd = $('key-dialog'), kf = $('key-form'), kerr = $('key-err');
  var ko = $('key-old'), kn = $('key-new'), kn2 = $('key-new2'), ksave = $('key-save');
  $('ad-chkey').addEventListener('click', function () { kf.reset(); kerr.textContent = ''; ksave.disabled = false; kd.showModal(); ko.focus(); });
  $('key-cancel').addEventListener('click', function () { kd.close(); });
  kf.addEventListener('submit', function (e) {
    e.preventDefault(); kerr.textContent = '';
    if (kn.value.length < DevKey.MIN) { kerr.textContent = 'Use at least ' + DevKey.MIN + ' characters.'; return; }
    if (kn.value !== kn2.value) { kerr.textContent = 'The new keys do not match.'; return; }
    ksave.disabled = true;
    DevKey.getConfig().then(function (cfg) {
      return (cfg ? DevKey.verify(ko.value, cfg) : Promise.resolve(true)).then(function (good) {
        if (!good) { kerr.textContent = 'The current key is wrong.'; ksave.disabled = false; return; }
        return DevKey.setKey(kn.value).then(function () { kd.close(); });
      });
    }).catch(function (x) { ksave.disabled = false; kerr.textContent = 'Could not save: ' + (x && x.message ? x.message : 'error'); });
  });

  document.addEventListener('lifeIsShortAuthState', load);
  setTimeout(function () { if (box.hidden) load(); }, 1500);
  load();
})();

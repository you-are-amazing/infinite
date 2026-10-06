/* Site notifications — include this script on EVERY page of the site.
   Shows a bell (with a red count) in the top bar, a badge next to "Team Goals" in the
   sidebar, another next to "Admin Inbox", a small pop-up for new messages, and a slide-in
   panel that lists everything unread.

   Two sources feed the same panel:
     - team chat messages, for any signed-in member;
     - Connect page messages, for the developer account only. These are marked read in
       Firestore (the same "read" flag the admin inbox uses), so they clear everywhere at once.

   Needs auth.js (Firebase Auth + Firestore) loaded on the same page.
   Works even if a page has no .top-actions bar (a floating bell is used instead).
   Exposes window.teamNotify = { markRead(teamId, upToMs), open(), count() } for team.js. */
(function () {
  'use strict';
  if (window.__teamNotifyLoaded) return;      // safe if a page accidentally includes it twice
  window.__teamNotifyLoaded = true;

  const SCRIPT_EL = document.currentScript || document.querySelector('script[src*="team-notify.js"]');
  const SCRIPT_SRC = SCRIPT_EL && SCRIPT_EL.src;
  // team-notify.js lives in /static/js/, the team page in /team/
  const TEAM_URL = SCRIPT_SRC ? new URL('../../team/', SCRIPT_SRC).href : 'team/';
  const CONTACT_URL = SCRIPT_SRC ? new URL('../../contact/', SCRIPT_SRC).href : 'contact/';
  const ON_TEAM_PAGE = /\/team(\/(index\.html)?)?$/.test(location.pathname);
  const ON_CONTACT_PAGE = /\/contact(\/(index\.html)?)?$/.test(location.pathname);
  const BASE_TITLE = document.title;
  // The account that owns the site. Only it may read every Connect message (see firestore.rules),
  // so only it gets contact notifications.
  const ADMIN_EMAIL = 'parmardarshan918@gmail.com';

  let user = null;
  let built = false;
  let teamsUnsub = null;
  let contactUnsub = null;
  let contactFirst = true;
  const watchers = {};      // teamId -> unsubscribe (messages + own read receipt)
  const teamNames = {};     // teamId -> name
  const readAt = {};        // teamId -> ms of my last read receipt from the server (any device)
  let items = [];           // { id, kind: 'team'|'contact', teamId, teamName, sender, text, ts }
  let toastTimer = null;
  let el = {};

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const msOf = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);

  function seenKey() { return 'team_chat_seen_' + (user ? user.uid : 'guest'); }
  function readSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || '{}') || {}; } catch (e) { return {}; } }
  function writeSeen(m) { try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch (e) {} }

  // How new a Connect message has to be before this device pings about it. "Read" itself is
  // server state, so this only stops the same message popping up again after a reload.
  function contactSeenKey() { return 'contact_seen_' + (user ? user.uid : 'guest'); }
  function readContactSeen() { try { return Number(localStorage.getItem(contactSeenKey())) || 0; } catch (e) { return 0; } }
  function writeContactSeen(ts) { try { localStorage.setItem(contactSeenKey(), String(ts)); } catch (e) {} }

  function isAdmin() {
    return !!(user && user.email && user.email.toLowerCase() === ADMIN_EMAIL);
  }

  /* ---------- UI ---------- */

  const CSS = `
    .nav-badge{margin-left:auto;min-width:18px;height:18px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--red,#f26d6d);color:#fff;font-size:10px;font-weight:800;font-style:normal}
    .nav-badge[hidden],.notif-badge[hidden],.notif-bell[hidden],.notif-overlay[hidden],.notif-toast[hidden]{display:none}
    .notif-float{position:fixed;top:12px;right:16px;z-index:95;display:flex;align-items:center;gap:9px}
    .notif-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border:1px solid var(--line-soft,#243044);border-radius:9px;background:var(--surface2,#131c2b);color:var(--muted,#8b98ad);font-size:14px;cursor:pointer}
    .notif-bell:hover,.notif-bell.has-new{color:var(--amber,#f5b04a);border-color:var(--amber,#f5b04a)}
    .notif-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;display:flex;align-items:center;justify-content:center;border-radius:999px;background:var(--red,#f26d6d);color:#fff;font-size:9px;font-weight:800;border:2px solid var(--surface,#0e1522)}
    .notif-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900}
    .notif-drawer{position:fixed;top:0;right:0;height:100%;width:360px;max-width:92vw;background:var(--surface,#0e1522);border-left:1px solid var(--line-soft,#243044);box-shadow:-12px 0 40px rgba(0,0,0,.4);z-index:910;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease;visibility:hidden}
    .notif-drawer.open{transform:translateX(0);visibility:visible}
    .nd-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line-soft,#243044);color:var(--text,#e9eff7);font-size:14px}
    .nd-head i{color:var(--amber,#f5b04a);margin-right:6px}
    .nd-actions{display:flex;align-items:center;gap:8px}
    .nd-actions button{background:var(--surface2,#131c2b);border:1px solid var(--line-soft,#243044);color:var(--muted,#8b98ad);border-radius:8px;padding:6px 10px;font-size:11.5px;cursor:pointer}
    .nd-actions button:hover{color:var(--text,#e9eff7)}
    .nd-list{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
    .nd-empty{color:var(--muted,#8b98ad);font-size:12.5px;text-align:center;padding:40px 10px}
    .nd-item{text-align:left;background:var(--surface2,#131c2b);border:1px solid var(--line-soft,#243044);border-radius:10px;padding:10px 12px;cursor:pointer;color:var(--text,#e9eff7);font-family:inherit}
    .nd-item:hover{border-color:var(--lav,#8f8ff0)}
    .nd-top{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted,#8b98ad);margin-bottom:4px}
    .nd-top strong{color:var(--lav,#8f8ff0);font-weight:700}
    .nd-msg{font-size:13px;word-break:break-word}
    .nd-time{font-size:10.5px;color:var(--faint,#5c6a80);margin-top:4px}
    .notif-toast{position:fixed;right:20px;bottom:20px;max-width:320px;background:var(--surface2,#131c2b);border:1px solid var(--lav,#8f8ff0);border-radius:12px;padding:12px 14px;color:var(--text,#e9eff7);font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.45);z-index:920;cursor:pointer;word-break:break-word}
    .notif-toast b{display:block;color:var(--lav,#8f8ff0);font-size:11.5px;margin-bottom:3px}
  `;

  function build() {
    if (built) return true;
    if (!document.body) return false;
    built = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Put the bell in the top bar if the page has one, otherwise float it top-right.
    let top = document.querySelector('.top-actions');
    if (!top) {
      top = document.createElement('div');
      top.className = 'notif-float';
      document.body.appendChild(top);
    }

    const bell = document.createElement('button');
    bell.type = 'button';
    bell.id = 'notif-bell';
    bell.className = 'notif-bell';
    bell.hidden = true;
    bell.title = 'Notifications';
    bell.setAttribute('aria-label', 'Notifications');
    bell.innerHTML = '<i class="fa-regular fa-bell"></i><span class="notif-badge" id="notif-badge" hidden>0</span>';
    const ref = $('sticky-bell-btn') || top.querySelector('.cloud-pill');
    top.insertBefore(bell, ref && ref.parentNode === top ? ref : null);

    const overlay = document.createElement('div');
    overlay.className = 'notif-overlay';
    overlay.id = 'notif-overlay';
    overlay.hidden = true;

    const drawer = document.createElement('aside');
    drawer.className = 'notif-drawer';
    drawer.id = 'notif-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('aria-label', 'Notifications');
    drawer.innerHTML =
      '<div class="nd-head"><b><i class="fa-regular fa-bell"></i> Notifications</b>' +
      '<span class="nd-actions"><button type="button" id="notif-readall">Mark all read</button>' +
      '<button type="button" id="notif-close" aria-label="Close">&times;</button></span></div>' +
      '<div class="nd-list" id="notif-list"></div>';

    const toast = document.createElement('div');
    toast.className = 'notif-toast';
    toast.id = 'notif-toast';
    toast.hidden = true;

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    document.body.appendChild(toast);

    // Badge next to "Team Goals" in the sidebar (matched by link or by label, whichever the page has).
    const navLink = Array.from(document.querySelectorAll('.nav-item')).find((a) =>
      /(^|\/)team\/?(index\.html)?$/.test(a.getAttribute('href') || '') || /team goals/i.test(a.textContent));
    let navBadge = null;
    if (navLink) {
      navBadge = document.createElement('span');
      navBadge.className = 'nav-badge';
      navBadge.hidden = true;
      navBadge.textContent = '0';
      navLink.appendChild(navBadge);
    }

    // Second badge, for unread Connect messages, on the "Admin Inbox" item.
    const adminLink = document.getElementById('nav-admin');
    let adminBadge = null;
    if (adminLink) {
      adminBadge = document.createElement('span');
      adminBadge.className = 'nav-badge';
      adminBadge.id = 'nav-admin-badge';
      adminBadge.hidden = true;
      adminBadge.textContent = '0';
      adminLink.appendChild(adminBadge);
    }

    el = { bell, badge: $('notif-badge'), navBadge, adminBadge, overlay, drawer, toast, list: $('notif-list') };

    bell.addEventListener('click', openDrawer);
    $('notif-close').addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);
    $('notif-readall').addEventListener('click', () => markRead(null));
    toast.addEventListener('click', openDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    // Another tab marked things as read -> follow it.
    window.addEventListener('storage', (e) => {
      if (e.key !== seenKey()) return;
      const seen = readSeen();
      items = items.filter((n) => n.ts > (seen[n.teamId] || 0));
      render();
    });
    render();
    return true;
  }

  function openDrawer() {
    el.drawer.classList.add('open');
    el.drawer.setAttribute('aria-hidden', 'false');
    el.overlay.hidden = false;
    el.toast.hidden = true;
  }
  function closeDrawer() {
    if (!el.drawer) return;
    el.drawer.classList.remove('open');
    el.drawer.setAttribute('aria-hidden', 'true');
    el.overlay.hidden = true;
  }

  function openTeam(teamId) {
    closeDrawer();
    if (ON_TEAM_PAGE) {
      document.dispatchEvent(new CustomEvent('teamNotifyOpenTeam', { detail: { teamId } }));
    } else {
      try { sessionStorage.setItem('team_open_id', teamId); } catch (e) {}
      location.href = TEAM_URL;
    }
  }

  /* A Connect notification leads to the Developer box, because that is what opens the inbox. */
  function openContact() {
    closeDrawer();
    if (ON_CONTACT_PAGE) {
      document.dispatchEvent(new CustomEvent('infiniteOpenDevGate'));
    } else {
      try { sessionStorage.setItem('infiniteOpenGate', '1'); } catch (e) {}
      location.href = CONTACT_URL;
    }
  }

  const contactItems = () => items.filter((n) => n.kind === 'contact');

  function render() {
    if (!built) return;
    const count = items.length;
    const label = count > 99 ? '99+' : String(count);
    el.bell.hidden = !user;
    el.badge.textContent = label;
    el.badge.hidden = count === 0;
    el.bell.classList.toggle('has-new', count > 0);
    if (el.navBadge) { el.navBadge.textContent = label; el.navBadge.hidden = count === 0; }
    if (el.adminBadge) {
      const n = contactItems().length;
      el.adminBadge.textContent = n > 99 ? '99+' : String(n);
      el.adminBadge.hidden = n === 0;
    }
    document.title = (count ? '(' + count + ') ' : '') + BASE_TITLE;

    if (!count) {
      el.list.innerHTML = '<div class="nd-empty">No new messages.<br>You\'ll see them here when a teammate writes in your team chat,'
        + (isAdmin() ? ' or when someone uses the Connect form.' : '.') + '</div>';
      return;
    }
    el.list.innerHTML = '';
    items.slice().sort((a, b) => b.ts - a.ts).forEach((n) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nd-item';
      const when = new Date(n.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const from = n.kind === 'contact' ? 'Connect page' : n.teamName;
      btn.innerHTML = '<div class="nd-top"><strong>' + esc(n.sender) + '</strong><span>' + esc(from) + '</span></div>' +
        '<div class="nd-msg">' + esc(n.text) + '</div><div class="nd-time">' + esc(when) + '</div>';
      btn.addEventListener('click', () => {
        if (n.kind === 'contact') openContact();
        else { markRead(n.teamId); openTeam(n.teamId); }
      });
      el.list.appendChild(btn);
    });
  }

  function showToast(item) {
    if (!built) return;
    const text = item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text;
    const from = item.kind === 'contact' ? 'Connect page' : item.teamName;
    el.toast.innerHTML = '<b>' + esc(item.sender) + ' · ' + esc(from) + '</b>' + esc(text);
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
  }

  // Marking a Connect message read writes the same "read" flag the inbox uses, so it clears on
  // every device at once. The rules only allow this for the account that owns the site.
  function markContactRead(ids) {
    const db = window.lifeIsShortDb;
    if (!db) return;
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      try {
        const batch = db.batch();
        chunk.forEach((id) => batch.update(db.collection('contactMessages').doc(id), { read: true }));
        batch.commit().catch((err) => console.warn('contact notifications: mark read failed', err));
      } catch (e) { console.warn('contact notifications: mark read failed', e); }
    }
  }

  // markRead(null)            -> everything (team receipts + the Connect "read" flag)
  // markRead(teamId)          -> that team's unread items
  // markRead(teamId, upToMs)  -> also remember "read up to this message time" (used by the team page)
  function markRead(teamId, upToMs) {
    const seen = readSeen();
    if (teamId && upToMs) seen[teamId] = Math.max(seen[teamId] || 0, upToMs);
    const contactIds = [];
    items = items.filter((n) => {
      if (n.kind === 'contact') {
        if (!teamId) { contactIds.push(n.id); return false; }   // "mark all read" clears these too
        return true;
      }
      seen[n.teamId] = Math.max(seen[n.teamId] || 0, n.ts);
      return teamId ? n.teamId !== teamId : false;
    });
    writeSeen(seen);
    render();
    if (contactIds.length) markContactRead(contactIds);
  }

  /* ---------- Firestore watching ---------- */

  function unwatch(id) {
    if (watchers[id]) { watchers[id](); delete watchers[id]; }
    delete readAt[id];
    items = items.filter((n) => n.teamId !== id);
  }

  function stop() {
    if (teamsUnsub) { teamsUnsub(); teamsUnsub = null; }
    if (contactUnsub) { contactUnsub(); contactUnsub = null; }
    contactFirst = true;
    Object.keys(watchers).forEach(unwatch);
    items = [];
    render();
  }

  /* Connect messages, for the owner account only. "Unread" is the server's own flag, so opening
     the inbox on another device clears the badge here too. */
  function watchContact(db) {
    contactUnsub = db.collection('contactMessages').orderBy('createdAt', 'desc').limit(50)
      .onSnapshot((snap) => {
        const seenAt = readContactSeen();
        const unread = [];
        let newest = seenAt;
        snap.docs.forEach((doc) => {
          const m = doc.data() || {};
          const ts = msOf(m.createdAt);
          if (!ts || m.read === true) return;
          if (ts > newest) newest = ts;
          const item = {
            id: doc.id, kind: 'contact', sender: m.name || 'Someone',
            email: m.email || '', text: m.message || '', ts,
          };
          unread.push(item);
          if (!contactFirst && ts > seenAt) showToast(item);
        });
        writeContactSeen(newest);
        contactFirst = false;
        items = items.filter((n) => n.kind !== 'contact').concat(unread);
        render();
      }, (err) => console.warn('contact notifications', err));
  }

  function watchMessages(teamDocs) {
    const db = window.lifeIsShortDb;
    const ids = teamDocs.map((d) => d.id);
    Object.keys(watchers).forEach((id) => { if (!ids.includes(id)) unwatch(id); });
    render();

    teamDocs.forEach((doc) => {
      teamNames[doc.id] = (doc.data() || {}).name || 'Team';
      if (watchers[doc.id]) return;
      let first = true;
      const teamRef = db.collection('teams').doc(doc.id);

      const unsubMessages = teamRef.collection('messages')
        .orderBy('createdAt', 'desc').limit(30)
        .onSnapshot((snap) => {
          const seenMap = readSeen();
          if (seenMap[doc.id] == null) {
            // First time on this device: whatever is already there counts as read.
            seenMap[doc.id] = snap.docs.reduce((m, d) => Math.max(m, msOf(d.data().createdAt)), 0);
            writeSeen(seenMap);
          }
          const seenTs = Math.max(seenMap[doc.id] || 0, readAt[doc.id] || 0);
          // Reading this team's chat right now (team page, tab in front)? Then it's not "unread".
          const watchingNow = ON_TEAM_PAGE && window.infiniteActiveTeamId === doc.id &&
            document.visibilityState === 'visible' && document.hasFocus();

          snap.docChanges().forEach((change) => {
            if (change.type === 'removed') {              // message deleted by its sender / owner
              items = items.filter((n) => n.id !== change.doc.id);
              return;
            }
            if (change.type !== 'added') return;
            const m = change.doc.data();
            const ts = msOf(m.createdAt);
            if (!ts || m.senderId === user.uid || ts <= seenTs || watchingNow) return;
            if (items.some((n) => n.id === change.doc.id)) return;
            const item = { id: change.doc.id, kind: 'team', teamId: doc.id, teamName: teamNames[doc.id], sender: m.senderName || 'Someone', text: m.text || '', ts };
            items.push(item);
            if (!first) showToast(item);
          });
          first = false;
          render();
        }, (err) => console.warn('team notifications', err));

      // My own read receipt (written by the team page, possibly on another device) clears older unread items.
      const unsubRead = teamRef.collection('reads').doc(user.uid)
        .onSnapshot((snap) => {
          const d = snap.exists ? snap.data({ serverTimestamps: 'estimate' }) : null;
          // msgAt is the exact newest message time they read; older receipts only have at.
          const at = d ? (Number(d.msgAt) || msOf(d.at)) : 0;
          if (!at) return;
          readAt[doc.id] = at;
          const before = items.length;
          items = items.filter((n) => !(n.teamId === doc.id && n.ts <= at));
          if (items.length !== before) render();
        }, () => {});

      watchers[doc.id] = () => { unsubMessages(); unsubRead(); };
    });
  }

  function start(nextUser) {
    if (user && nextUser && user.uid === nextUser.uid && teamsUnsub) return;
    stop();
    user = nextUser || null;
    if (!build()) return;
    render();
    if (!user) return;
    let tries = 0;
    const attach = () => {
      const db = window.lifeIsShortDb;
      if (!db) { if (++tries < 50) setTimeout(attach, 200); return; }
      teamsUnsub = db.collection('teams').where('memberIds', 'array-contains', user.uid)
        .onSnapshot((snap) => watchMessages(snap.docs), (err) => console.warn('team notifications', err));
      if (isAdmin() && !contactUnsub) watchContact(db);
    };
    attach();
  }

  function init() {
    build();
    document.addEventListener('lifeIsShortAuthState', (e) => start(e.detail && e.detail.user));
    // Backup in case the sign-in announcement happened before this script was ready.
    let tries = 0;
    const poll = setInterval(() => {
      if (window.lifeIsShortUser && !user) { clearInterval(poll); start(window.lifeIsShortUser); }
      else if (++tries > 40) clearInterval(poll);
    }, 250);
  }

  window.teamNotify = {
    markRead,
    open: () => { if (built) openDrawer(); },
    count: () => items.length
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

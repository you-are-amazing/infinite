/* Team chat notifications — shared by every page that has a top bar.
   Shows a bell (with a red count) in the top bar, a badge next to "Team Goals"
   in the sidebar, a small pop-up for new messages, and a slide-in panel that
   lists unread messages from teammates. Needs auth.js (Firebase) on the page. */
(function () {
  'use strict';

  const SCRIPT_SRC = document.currentScript && document.currentScript.src;
  const TEAM_URL = SCRIPT_SRC ? new URL('../../team/', SCRIPT_SRC).href : 'team/';
  const ON_TEAM_PAGE = /\/team(\/(index\.html)?)?$/.test(location.pathname);
  const BASE_TITLE = document.title;

  let user = null;
  let built = false;
  let teamsUnsub = null;
  const watchers = {};      // teamId -> unsubscribe
  const teamNames = {};     // teamId -> name
  let items = [];           // { id, teamId, teamName, sender, text, ts }
  let toastTimer = null;
  let el = {};

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const msOf = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);

  function seenKey() { return 'team_chat_seen_' + (user ? user.uid : 'guest'); }
  function readSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || '{}') || {}; } catch (e) { return {}; } }
  function writeSeen(m) { try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch (e) {} }

  /* ---------- UI ---------- */

  const CSS = `
    .nav-badge{margin-left:auto;min-width:18px;height:18px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--red,#f26d6d);color:#fff;font-size:10px;font-weight:800;font-style:normal}
    .nav-badge[hidden],.notif-badge[hidden],.notif-bell[hidden],.notif-overlay[hidden],.notif-toast[hidden]{display:none}
    .notif-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border:1px solid var(--line-soft,#243044);border-radius:9px;background:var(--surface2,#131c2b);color:var(--muted,#8b98ad);font-size:14px;cursor:pointer}
    .notif-bell:hover,.notif-bell.has-new{color:var(--amber,#f5b04a);border-color:var(--amber,#f5b04a)}
    .notif-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;display:flex;align-items:center;justify-content:center;border-radius:999px;background:var(--red,#f26d6d);color:#fff;font-size:9px;font-weight:800;border:2px solid var(--surface,#0e1522)}
    .notif-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:90}
    .notif-drawer{position:fixed;top:0;right:0;height:100%;width:360px;max-width:92vw;background:var(--surface,#0e1522);border-left:1px solid var(--line-soft,#243044);box-shadow:-12px 0 40px rgba(0,0,0,.4);z-index:100;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease}
    .notif-drawer.open{transform:translateX(0)}
    .nd-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line-soft,#243044);color:var(--text,#e9eff7);font-size:14px}
    .nd-head i{color:var(--amber,#f5b04a);margin-right:6px}
    .nd-actions{display:flex;align-items:center;gap:8px}
    .nd-actions button{background:var(--surface2,#131c2b);border:1px solid var(--line-soft,#243044);color:var(--muted,#8b98ad);border-radius:8px;padding:6px 10px;font-size:11.5px;cursor:pointer}
    .nd-actions button:hover{color:var(--text,#e9eff7)}
    .nd-list{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
    .nd-empty{color:var(--muted,#8b98ad);font-size:12.5px;text-align:center;padding:40px 10px}
    .nd-item{text-align:left;background:var(--surface2,#131c2b);border:1px solid var(--line-soft,#243044);border-radius:10px;padding:10px 12px;cursor:pointer;color:var(--text,#e9eff7)}
    .nd-item:hover{border-color:var(--lav,#8f8ff0)}
    .nd-top{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted,#8b98ad);margin-bottom:4px}
    .nd-top strong{color:var(--lav,#8f8ff0);font-weight:700}
    .nd-msg{font-size:13px;word-break:break-word}
    .nd-time{font-size:10.5px;color:var(--faint,#5c6a80);margin-top:4px}
    .notif-toast{position:fixed;right:20px;bottom:20px;max-width:320px;background:var(--surface2,#131c2b);border:1px solid var(--lav,#8f8ff0);border-radius:12px;padding:12px 14px;color:var(--text,#e9eff7);font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.45);z-index:110;cursor:pointer}
    .notif-toast b{display:block;color:var(--lav,#8f8ff0);font-size:11.5px;margin-bottom:3px}
  `;

  function build() {
    if (built) return true;
    const top = document.querySelector('.top-actions');
    if (!top) return false;
    built = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const bell = document.createElement('button');
    bell.type = 'button';
    bell.id = 'notif-bell';
    bell.className = 'notif-bell';
    bell.hidden = true;
    bell.title = 'Team chat notifications';
    bell.setAttribute('aria-label', 'Team chat notifications');
    bell.innerHTML = '<i class="fa-regular fa-bell"></i><span class="notif-badge" id="notif-badge" hidden>0</span>';
    const ref = $('sticky-bell-btn') || top.querySelector('.cloud-pill');
    top.insertBefore(bell, ref || null);

    const overlay = document.createElement('div');
    overlay.className = 'notif-overlay';
    overlay.id = 'notif-overlay';
    overlay.hidden = true;

    const drawer = document.createElement('aside');
    drawer.className = 'notif-drawer';
    drawer.id = 'notif-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('aria-label', 'Team chat notifications');
    drawer.innerHTML =
      '<div class="nd-head"><b><i class="fa-regular fa-bell"></i> Team messages</b>' +
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

    // Badge next to "Team Goals" in the sidebar.
    const navLink = Array.from(document.querySelectorAll('.nav-item')).find((a) => /team goals/i.test(a.textContent));
    let navBadge = null;
    if (navLink) {
      navBadge = document.createElement('span');
      navBadge.className = 'nav-badge';
      navBadge.hidden = true;
      navBadge.textContent = '0';
      navLink.appendChild(navBadge);
    }

    el = { bell, badge: $('notif-badge'), navBadge, overlay, drawer, toast, list: $('notif-list') };

    bell.addEventListener('click', openDrawer);
    $('notif-close').addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);
    $('notif-readall').addEventListener('click', () => markRead(null));
    toast.addEventListener('click', openDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
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

  function render() {
    if (!built) return;
    const count = items.length;
    const label = count > 99 ? '99+' : String(count);
    el.bell.hidden = !user;
    el.badge.textContent = label;
    el.badge.hidden = count === 0;
    el.bell.classList.toggle('has-new', count > 0);
    if (el.navBadge) { el.navBadge.textContent = label; el.navBadge.hidden = count === 0; }
    document.title = (count ? '(' + count + ') ' : '') + BASE_TITLE;

    if (!count) {
      el.list.innerHTML = '<div class="nd-empty">No new messages.<br>You\'ll see them here when a teammate writes in your team chat.</div>';
      return;
    }
    el.list.innerHTML = '';
    items.slice().sort((a, b) => b.ts - a.ts).forEach((n) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nd-item';
      const when = new Date(n.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      btn.innerHTML = '<div class="nd-top"><strong>' + esc(n.sender) + '</strong><span>' + esc(n.teamName) + '</span></div>' +
        '<div class="nd-msg">' + esc(n.text) + '</div><div class="nd-time">' + esc(when) + '</div>';
      btn.addEventListener('click', () => { markRead(n.teamId); openTeam(n.teamId); });
      el.list.appendChild(btn);
    });
  }

  function showToast(item) {
    if (!built) return;
    const text = item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text;
    el.toast.innerHTML = '<b>' + esc(item.sender) + ' · ' + esc(item.teamName) + '</b>' + esc(text);
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
  }

  function markRead(teamId) {
    const seen = readSeen();
    items.forEach((n) => {
      if (teamId && n.teamId !== teamId) return;
      seen[n.teamId] = Math.max(seen[n.teamId] || 0, n.ts);
    });
    writeSeen(seen);
    items = teamId ? items.filter((n) => n.teamId !== teamId) : [];
    render();
  }

  /* ---------- Firestore watching ---------- */

  function stop() {
    if (teamsUnsub) { teamsUnsub(); teamsUnsub = null; }
    Object.keys(watchers).forEach((id) => { watchers[id](); delete watchers[id]; });
    items = [];
    render();
  }

  function watchMessages(teamDocs) {
    const db = window.lifeIsShortDb;
    const ids = teamDocs.map((d) => d.id);
    Object.keys(watchers).forEach((id) => {
      if (!ids.includes(id)) { watchers[id](); delete watchers[id]; items = items.filter((n) => n.teamId !== id); }
    });
    teamDocs.forEach((doc) => {
      teamNames[doc.id] = (doc.data() || {}).name || 'Team';
      if (watchers[doc.id]) return;
      let first = true;
      watchers[doc.id] = db.collection('teams').doc(doc.id).collection('messages')
        .orderBy('createdAt', 'desc').limit(30)
        .onSnapshot((snap) => {
          const seenMap = readSeen();
          if (seenMap[doc.id] == null) {
            // First time on this device: whatever is already there counts as read.
            seenMap[doc.id] = snap.docs.reduce((m, d) => Math.max(m, msOf(d.data().createdAt)), 0);
            writeSeen(seenMap);
          }
          const seenTs = seenMap[doc.id];
          snap.docChanges().forEach((change) => {
            if (change.type !== 'added') return;
            const m = change.doc.data();
            const ts = msOf(m.createdAt);
            if (!ts || m.senderId === user.uid || ts <= seenTs) return;
            if (items.some((n) => n.id === change.doc.id)) return;
            const item = { id: change.doc.id, teamId: doc.id, teamName: teamNames[doc.id], sender: m.senderName || 'Someone', text: m.text || '', ts };
            items.push(item);
            if (!first) showToast(item);
          });
          first = false;
          render();
        }, (err) => console.warn('team notifications', err));
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
/* Infinite AI v2 — full-page chat workspace with a pixel-art mascot.
 * Self-contained: injects its own ball, workspace and CSS, and consumes the global
 * motion tokens from static/css/style.css (--m-*). Motion is switched off by
 * prefers-reduced-motion and by <html data-motion="off">.
 *
 * Talks to the `chat` Cloud Function. The AI only PROPOSES changes; nothing is saved until
 * the user presses Add on a card, and then it is written to localStorage in Infinite's own
 * formats, so the normal cloud sync picks it up.
 */
(function () {
  'use strict';
  var REGION = 'asia-south1';               // must match REGION in functions/index.js
  var AI_DASHBOARD_URL = new URL('../../ai/', document.currentScript.src).href;
  var CHATS_PREFIX = 'infinite_ai_chats_v2'; // per-user chat history in localStorage
  var ACTIVE_KEY = 'infinite_ai_active_v2';
  var MAX_SEND = 20;
  var MAX_CHATS = 30;
  var MAX_MSGS = 80;

  var chats = [];                            // [{id,title,created,updated,messages:[{role,text,actions}]}]
  var activeId = null;
  var loadedUid = null;
  var busy = false;
  var ws, list, scroller, input, sendBtn, ball, railEl, headMascot, callable = null;

  /* ---------------- small helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Safe mini-markdown: escape first, then inline marks, headings, bullets and numbers.
  function fmt(text) {
    var lines = esc(text).split('\n'), out = '', list = null;
    function closeList() { if (list) { out += '</' + list + '>'; list = null; } }
    lines.forEach(function (ln) {
      var head = ln.match(/^\s*(#{1,4})\s+(.*)$/);
      var ul = ln.match(/^\s*[-*•]\s+(.*)$/);
      var ol = ln.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ul || ol) {
        var want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); out += '<' + want + '>'; list = want; }
        out += '<li>' + inline(ul ? ul[1] : ol[2]) + '</li>';
        return;
      }
      closeList();
      if (head) out += '<b class="aic-h">' + inline(head[2]) + '</b>';
      else if (ln.trim()) out += '<p>' + inline(ln) + '</p>';
    });
    closeList();
    return out;
    function inline(s) {
      return s.replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])_([^_]+)_/g, '$1<i>$2</i>');
    }
  }
  function readJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function today() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function titleFrom(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return 'New chat';
    return t.length > 42 ? t.slice(0, 42).trim() + '…' : t;
  }
  function currentUser() {
    return window.lifeIsShortUser || (window.lifeIsShortAuth && window.lifeIsShortAuth.currentUser) || null;
  }
  function uid() { var u = currentUser(); return (u && u.uid) || 'guest'; }
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 1700);
  }

  /* ---------------- chat storage ---------------- */
  function load() {
    loadedUid = uid();
    var all = readJSON(CHATS_PREFIX, {});
    var mine = all[loadedUid] || [];
    chats = (Array.isArray(mine) ? mine : []).filter(function (c) { return c && Array.isArray(c.messages); })
      .map(function (c) {
        return {
          id: String(c.id || Date.now()),
          title: c.title || 'New chat',
          created: c.created || Date.now(),
          updated: c.updated || Date.now(),
          messages: c.messages.slice(-MAX_MSGS).map(function (m) {
            return { role: m.role === 'user' ? 'user' : 'model', text: String(m.text || ''), actions: m.actions || [] };
          }),
        };
      }).slice(0, MAX_CHATS);
    activeId = localStorage.getItem(ACTIVE_KEY + '_' + loadedUid);
    if (!activeId || !chats.some(function (c) { return c.id === activeId; })) activeId = null;
    if (!chats.length) newChat(false);
  }
  function save() {
    var all = readJSON(CHATS_PREFIX, {});
    all[uid()] = chats.slice(0, MAX_CHATS);
    try { localStorage.setItem(CHATS_PREFIX, JSON.stringify(all)); } catch (e) {}
    try {
      if (activeId) localStorage.setItem(ACTIVE_KEY + '_' + uid(), activeId);
      else localStorage.removeItem(ACTIVE_KEY + '_' + uid());
    } catch (e) {}
  }
  function newChat(select) {
    var c = { id: String(Date.now()) + Math.floor(Math.random() * 99), title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
    chats.unshift(c);
    if (select !== false) { activeId = c.id; save(); render(); }
    else { activeId = c.id; save(); }
    return c;
  }
  function active() {
    var c = chats.filter(function (x) { return x.id === activeId; })[0];
    if (!c) { c = newChat(false); renderRail(); }
    return c;
  }
  function deleteChat(id) {
    chats = chats.filter(function (c) { return c.id !== id; });
    if (!chats.length) newChat(false);
    else if (activeId === id) activeId = chats[0].id;
    save(); render();
  }

  /* ---------------- applying a confirmed action ---------------- */
  function refreshPages() { document.dispatchEvent(new CustomEvent('lifeIsShortDataReady')); }

  function applyAction(a) {
    var args = a.args || {};
    if (a.name === 'propose_goal') {
      var goals = readJSON('goals', []);
      goals.push({ id: Date.now() + Math.floor(Math.random() * 999), text: String(args.text).slice(0, 140),
        goal_type: args.goal_type, done: false, created: new Date().toISOString() });
      localStorage.setItem('goals', JSON.stringify(goals));
    } else if (a.name === 'propose_complete_goal') {
      var gs = readJSON('goals', []);
      var g = gs.filter(function (x) { return Number(x.id) === Number(args.goal_id); })[0];
      if (!g) throw new Error('That goal no longer exists.');
      g.done = true;
      localStorage.setItem('goals', JSON.stringify(gs));
    } else if (a.name === 'propose_note') {
      var notes = readJSON('life_notes', []);
      var html = String(args.body || '').split('\n').map(function (l) {
        return l.trim() ? '<div>' + esc(l) + '</div>' : '<div><br></div>';
      }).join('');
      notes.unshift({ id: Date.now() + '-' + Math.random().toString(16).slice(2), title: String(args.title || 'Untitled').slice(0, 120),
        body: html, updatedAt: new Date().toISOString() });
      localStorage.setItem('life_notes', JSON.stringify(notes));
    } else if (a.name === 'propose_youtube_link') {
      var links = readJSON('life_inspire_links', []);
      if (links.some(function (x) { return x.vid === args.vid; })) return 'Already in your Inspire Feed';
      links.unshift({ id: String(Date.now()) + '_' + args.vid, vid: args.vid,
        url: 'https://www.youtube.com/watch?v=' + args.vid, addedAt: new Date().toISOString() });
      localStorage.setItem('life_inspire_links', JSON.stringify(links));
    } else {
      throw new Error('Unknown action');
    }
    refreshPages();
    return 'Added';
  }

  function describe(a) {
    var x = a.args || {};
    if (a.name === 'propose_goal') return { icon: 'fa-bullseye', label: 'New ' + x.goal_type + ' goal', body: x.text };
    if (a.name === 'propose_complete_goal') return { icon: 'fa-circle-check', label: 'Mark goal as done', body: x.text };
    if (a.name === 'propose_note') return { icon: 'fa-note-sticky', label: 'New note', body: x.title };
    if (a.name === 'propose_youtube_link') return { icon: 'fa-brands fa-youtube', label: 'Save to Inspire Feed', body: x.url };
    return { icon: 'fa-bolt', label: a.name, body: '' };
  }

  /* ---------------- the pixel mascot ---------------- */
  /* 16 x 18 grid, 4px cells. o=outline l=light d=mid v=visor #=eye y=antenna tip */
  var ART = [
    '.......yy.......',
    '.......dd.......',
    '.......dd.......',
    '..oooooooooooo..',
    '.olllllllllllo.',
    '.olllllllllllo.',
    '.olllllllllllo.',
    '.ollddddddddllo.',
    '.ollv###v###vllo.',
    '.ollv#v#v#v#vllo.',
    '.ollv###v###vllo.',
    '.ollddddddddllo.',
    '.ollddddddddllo.',
    '.olllllllllllo.',
    '.olllddddddlllo.',
    '.olllllllllllo.',
    '..oooooooooooo..',
    '.....dddddd.....',
  ];
  var PIXEL_CLASS = { o: 'aic-px-o', l: 'aic-px-l', d: 'aic-px-d', v: 'aic-px-v', '#': 'aic-px-e', y: 'aic-px-y' };
  var CELL = 4;

  function mascotSVG(cls) {
    var rects = '';
    ART.forEach(function (row, r) {
      var c = 0;
      while (c < row.length) {
        var ch = row[c];
        if (ch === '.') { c++; continue; }
        var run = 1;
        while (c + run < row.length && row[c + run] === ch) run++;
        rects += '<rect class="' + PIXEL_CLASS[ch] + '" x="' + (c * CELL) + '" y="' + (r * CELL) +
          '" width="' + (run * CELL) + '" height="' + CELL + '"/>';
        c += run;
      }
    });
    return '<span class="aic-m ' + (cls || '') + '" aria-hidden="true">' +
      '<svg class="aic-m-svg" viewBox="0 0 64 72" focusable="false">' +
      '<g class="aic-m-wrap">' + rects +
      '<rect class="aic-m-scan" x="16" y="28" width="32" height="2"/>' +
      '<rect class="aic-m-scan aic-m-scan-b" x="16" y="28" width="32" height="2"/>' +
      '</g></svg></span>';
  }

  /* ---------------- rendering ---------------- */
  function suggestionsFor(chat) {
    if (!chat.messages.length) {
      return ['What are my goals right now?', 'Help me plan my week', 'Suggest goals for this week',
        'Summarise my notes', 'Break my yearly goal into steps'];
    }
    var last = chat.messages[chat.messages.length - 1];
    if (last && last.role === 'user') return ['Make it shorter', 'Give me a step-by-step plan', 'Save this as a note'];
    return ['What should I focus on this week?', 'Review my progress', 'Add a goal from this', 'Save this as a note'];
  }

  function renderRail() {
    var user = currentUser();
    var html = '<button type="button" class="aic-new" id="aic-new"><i class="fa-solid fa-plus"></i>New chat</button>';
    if (!chats.length) html += '<div class="aic-rail-empty">No conversations yet.</div>';
    chats.forEach(function (c) {
      var last = c.messages[c.messages.length - 1];
      var snippet = last ? last.text.replace(/\s+/g, ' ').slice(0, 46) : 'Ask anything to begin.';
      html += '<div class="aic-chat' + (c.id === activeId ? ' on' : '') + '" data-id="' + esc(c.id) + '" tabindex="0" role="button">' +
        '<div class="aic-chat-t">' + esc(c.title) + '</div>' +
        '<div class="aic-chat-s">' + esc(snippet) + '</div>' +
        '<div class="aic-chat-m"><span>' + c.messages.length + ' msg</span><span>' + ago(c.updated) + '</span>' +
        '<button type="button" class="aic-chat-x" data-del="' + esc(c.id) + '" title="Delete chat" aria-label="Delete chat">' +
        '<i class="fa-solid fa-trash-can"></i></button></div></div>';
    });
    railEl.innerHTML = html;
    var who = ws.querySelector('.aic-rail-who b');
    if (who) who.textContent = user ? (user.displayName || 'You') : 'Guest';
  }

  function render() {
    var user = currentUser();
    if (!user) {
      list.innerHTML = '<div class="aic-empty">' + mascotSVG('aic-m-hero') +
        '<b class="aic-empty-hi">Sign in to use Infinite AI.</b>' +
        '<span>The assistant reads your goals and notes, so it needs your account. Guest mode keeps data only on this device.</span></div>';
      input.disabled = true; sendBtn.disabled = true;
      setMascotState('');
      renderRail();
      return;
    }
    input.disabled = false; sendBtn.disabled = busy;

    var chat = active();
    var html = '';
    if (!chat.messages.length) {
      html += '<div class="aic-empty">' + mascotSVG('aic-m-hero') +
        '<b class="aic-empty-hi">Hi' + (user.displayName ? ', ' + esc(user.displayName.split(' ')[0]) : '') + '. What are you working toward?</b>' +
        '<span>I can read your goals and notes, help you plan, and prepare changes for you to approve.</span></div>';
    }
    chat.messages.forEach(function (m, mi) {
      html += '<div class="aic-msg ' + (m.role === 'user' ? 'me' : 'ai') + '">' +
        (m.role === 'user' ? '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>' : fmt(m.text)) + '</div>';
      (m.actions || []).forEach(function (a, ai) {
        var d = describe(a);
        html += '<div class="aic-card" data-s="' + esc(a.status) + '"><div class="aic-card-ic"><i class="fa-solid ' + d.icon + '"></i></div>' +
          '<div class="aic-card-tx"><small>' + esc(d.label) + '</small><div>' + esc(d.body) + '</div></div>' +
          (a.status === 'pending'
            ? '<div class="aic-card-btns"><button type="button" class="aic-add" data-m="' + mi + '" data-a="' + ai + '">Add</button>' +
              '<button type="button" class="aic-skip" data-m="' + mi + '" data-a="' + ai + '">Skip</button></div>'
            : '<span class="aic-card-done">' + (a.status === 'added' ? 'Added' : a.status === 'skipped' ? 'Skipped' : esc(a.status)) + '</span>') +
          '</div>';
      });
    });
    if (busy) html += '<div class="aic-msg ai aic-typing"><span></span><span></span><span></span></div>';
    list.innerHTML = html;
    scrollDown();
    setMascotState(busy ? 'thinking' : '');
    renderRail();
    renderSug();
  }

  function scrollDown() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }

  function renderSug() {
    var box = ws.querySelector('#aic-sug');
    if (!box) return;
    var chat = chats.filter(function (x) { return x.id === activeId; })[0];
    var items = (busy || !currentUser() || !chat) ? [] : suggestionsFor(chat);
    box.innerHTML = items.map(function (t) {
      return '<button type="button" class="aic-sug-i" data-q="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    box.hidden = !items.length;
  }

  function setMascotState(state) {
    if (!headMascot) return;
    headMascot.className = 'aic-m ' + state;
  }

  /* ---------------- sending ---------------- */
  function getCallable() {
    if (callable) return callable;
    if (!window.firebase || !firebase.functions) throw new Error('The Firebase Functions script is not loaded on this page.');
    callable = firebase.app().functions(REGION).httpsCallable('chat', { timeout: 90000 });
    return callable;
  }

  function friendly(err) {
    var code = (err && err.code) || '';
    if (code.indexOf('unauthenticated') >= 0) return 'Please sign in again, then retry.';
    if (code.indexOf('resource-exhausted') >= 0) return err.message || 'Limit reached. Try again later.';
    if (code.indexOf('not-found') >= 0 || code.indexOf('unavailable') >= 0) return 'Infinite AI is not deployed yet or is unreachable.';
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || busy || !currentUser()) return;
    var chat = active();
    var isFirst = !chat.messages.length;
    chat.messages.push({ role: 'user', text: text.slice(0, 2000) });
    if (isFirst) chat.title = titleFrom(text);
    chat.updated = Date.now();
    input.value = ''; autosize();
    busy = true; save(); render();
    var payload = chat.messages.slice(-MAX_SEND).map(function (m) { return { role: m.role, text: m.text }; });
    var p;
    try { p = getCallable()({ messages: payload, today: today() }); } catch (e) { p = Promise.reject(e); }
    p.then(function (res) {
      var d = (res && res.data) || {};
      var acts = (d.proposed || []).map(function (a, i) { return { id: Date.now() + '-' + i, name: a.name, args: a.args, status: 'pending' }; });
      chat.messages.push({ role: 'model', text: d.reply || '', actions: acts });
    }).catch(function (err) {
      console.warn('Infinite AI error', err);
      chat.messages.push({ role: 'model', text: friendly(err) });
    }).then(function () {
      chat.updated = Date.now();
      busy = false; save(); render(); input.focus();
    });
  }

  /* ---------------- UI ---------------- */
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
  function open() {
    ws.classList.add('open');
    ball.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('aic-locked');
    render();
    setTimeout(function () { input.focus(); }, 60);
  }
  function close() {
    ws.classList.remove('open');
    ball.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('aic-locked');
  }

  function buildCSS() {
    var css = document.createElement('style');
    css.id = 'aic-v2-css';
    css.textContent = [
      'html.aic-locked{overflow:hidden}',

      '/* ---------- launcher ball ---------- */',
      '.aic-ball{position:fixed;right:20px;bottom:20px;z-index:900;width:54px;height:54px;border-radius:50%;border:1px solid var(--line);background:radial-gradient(circle at 32% 26%,var(--surface3),var(--surface));color:var(--green);font-size:23px;cursor:pointer;box-shadow:var(--shadow);display:none;align-items:center;justify-content:center;transition:transform var(--m-dur) var(--m-ease-spring),border-color var(--m-dur) var(--m-ease)}',
      '.aic-ball.show{display:flex}',
      '.aic-ball:hover{transform:translateY(-3px) scale(1.05);border-color:var(--green)}',
      '.aic-ball:active{transform:translateY(0) scale(.97)}',
      '.aic-ball-side{position:relative;right:auto;bottom:auto;margin:auto;flex:none;width:64px;height:64px;font-size:28px}',
      '.aic-ball-side:hover{transform:translateY(-3px) scale(1.05)}',
      '.aic-ball-team{margin:10px auto 14px}',
      'body:has(#inspire-rail) .aic-ball:not(.aic-ball-side){right:calc(clamp(300px, 22vw, 360px) + 24px)}',
      '@media (max-width:1100px){body:has(#inspire-rail) .aic-ball:not(.aic-ball-side){right:20px}}',
      '@media (max-width:860px){.aic-ball-side{width:44px;height:44px;font-size:20px}}',

      '/* ---------- workspace shell ---------- */',
      '.aic-ws{position:fixed;inset:0;z-index:1200;background:var(--bg);color:var(--text);font-family:inherit;display:none;grid-template-columns:246px 1fr}',
      '.aic-ws.open{display:grid}',
      '.aic-rail{border-right:1px solid var(--line-soft);background:var(--surface);display:flex;flex-direction:column;overflow:hidden}',
      '.aic-rail-h{display:flex;align-items:center;gap:9px;padding:14px;border-bottom:1px solid var(--line-soft)}',
      '.aic-rail-h .aic-m{flex:none}',
      '.aic-rail-h b{font-size:13px;display:block;letter-spacing:.02em}',
      '.aic-rail-h small{color:var(--muted);font-size:11px}',
      '.aic-new{margin:12px;display:flex;align-items:center;justify-content:center;gap:7px;width:calc(100% - 24px);padding:9px;border-radius:10px;border:1px solid var(--line);background:var(--green-soft);color:var(--green);font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:background var(--m-dur) var(--m-ease),transform var(--m-dur-fast) var(--m-ease)}',
      '.aic-new:hover{background:var(--green);color:#06140d}',
      '.aic-new:active{transform:scale(.98)}',
      '.aic-rail-list{flex:1;overflow-y:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:4px}',
      '.aic-chat{border:1px solid transparent;border-radius:10px;padding:8px 10px;cursor:pointer;transition:background var(--m-dur) var(--m-ease),border-color var(--m-dur) var(--m-ease)}',
      '.aic-chat:hover{background:var(--surface2)}',
      '.aic-chat.on{background:var(--surface2);border-color:var(--line)}',
      '.aic-chat-t{font-size:12.8px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.aic-chat-s{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
      '.aic-chat-m{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--faint);margin-top:5px}',
      '.aic-chat-x{margin-left:auto;background:none;border:0;color:var(--faint);cursor:pointer;font-size:11px;padding:2px;border-radius:6px;opacity:0;transition:opacity var(--m-dur-fast) var(--m-ease),color var(--m-dur-fast) var(--m-ease)}',
      '.aic-chat:hover .aic-chat-x,.aic-chat.on .aic-chat-x{opacity:1}',
      '.aic-chat-x:hover{color:var(--red);background:var(--red-soft)}',
      '.aic-rail-empty{color:var(--faint);font-size:12px;padding:6px 10px}',
      '.aic-rail-foot{border-top:1px solid var(--line-soft);padding:10px 14px;font-size:11.5px;color:var(--muted)}',
      '.aic-rail-who b{color:var(--text)}',

      '/* ---------- main column ---------- */',
      '.aic-main{display:flex;flex-direction:column;min-width:0;overflow:hidden}',
      '.aic-head{display:flex;align-items:center;gap:11px;padding:12px 18px;border-bottom:1px solid var(--line-soft);background:var(--surface)}',
      '.aic-head h3{margin:0;font-size:15px;font-weight:700;line-height:1.2}',
      '.aic-head small{display:block;font-weight:400;font-size:11.5px;color:var(--muted)}',
      '.aic-head-sp{flex:1}',
      '.aic-head button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:14px;padding:7px 9px;border-radius:8px;transition:background var(--m-dur-fast) var(--m-ease),color var(--m-dur-fast) var(--m-ease)}',
      '.aic-head button:hover{color:var(--text);background:var(--line-soft)}',

      '/* ---------- messages ---------- */',
      '.aic-list{flex:1;overflow-y:auto;padding:20px 18px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}',
      '.aic-inner{flex:1;min-height:0;width:min(760px,100%);margin:0 auto;display:flex;flex-direction:column;gap:10px}',
      '.aic-msg{max-width:86%;padding:10px 13px;border-radius:13px;font-size:13.5px;line-height:1.55;word-wrap:break-word}',
      '.aic-msg p{margin:0 0 6px}.aic-msg p:last-child{margin:0}.aic-msg ul,.aic-msg ol{margin:4px 0 6px;padding-left:19px}',
      '.aic-msg li{margin:2px 0}',
      '.aic-msg b.aic-h{display:block;margin:2px 0 4px;color:var(--green);font-size:13px;letter-spacing:.02em}',
      '.aic-msg code{background:var(--surface3);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:12px}',
      '.aic-msg.me{align-self:flex-end;background:var(--green-soft);border:1px solid rgba(61,220,151,.25)}',
      '.aic-msg.ai{align-self:flex-start;background:var(--surface2);border:1px solid var(--line-soft)}',
      '.aic-empty{margin:auto 0;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;font-size:13.5px}',
      '.aic-empty-hi{font-size:17px}',
      '.aic-empty span{color:var(--muted);line-height:1.55;max-width:460px}',
      '.aic-typing{display:flex;gap:4px;padding:12px}',
      '.aic-typing span{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:aicDot 1s infinite}',
      '.aic-typing span:nth-child(2){animation-delay:.15s}.aic-typing span:nth-child(3){animation-delay:.3s}',
      '@keyframes aicDot{0%,80%,100%{opacity:.25}40%{opacity:1}}',

      '/* ---------- proposal cards ---------- */',
      '.aic-card{align-self:stretch;display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-left:3px solid var(--lav);border-radius:11px;padding:10px 11px;background:var(--surface)}',
      '.aic-card[data-s=added]{border-left-color:var(--green)}.aic-card[data-s=skipped]{opacity:.55}',
      '.aic-card-ic{color:var(--lav);width:18px;text-align:center}.aic-card[data-s=added] .aic-card-ic{color:var(--green)}',
      '.aic-card-tx{flex:1;min-width:0;font-size:13px}.aic-card-tx small{display:block;color:var(--muted);font-size:11.5px}',
      '.aic-card-tx div{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
      '.aic-card-btns{display:flex;gap:6px}',
      '.aic-add,.aic-skip{font:inherit;font-size:12.5px;border-radius:8px;padding:5px 11px;cursor:pointer;border:1px solid var(--line);background:none;color:var(--text)}',
      '.aic-add{background:var(--green);border-color:var(--green);color:#06140d;font-weight:600}',
      '.aic-card-done{font-size:12px;color:var(--muted)}',

      '/* ---------- composer ---------- */',
      '.aic-foot{border-top:1px solid var(--line-soft);background:var(--surface);padding:12px 18px 14px}',
      '.aic-sug{display:flex;flex-wrap:wrap;gap:6px;margin:0 auto 10px;width:min(760px,100%)}',
      '.aic-sug[hidden]{display:none}',
      '.aic-sug-i{background:none;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;transition:border-color var(--m-dur-fast) var(--m-ease),color var(--m-dur-fast) var(--m-ease)}',
      '.aic-sug-i:hover{border-color:var(--green);color:var(--green)}',
      '.aic-compose{display:flex;gap:9px;align-items:flex-end;width:min(760px,100%);margin:0 auto}',
      '.aic-compose textarea{flex:1;resize:none;max-height:140px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit;font-size:13.5px;line-height:1.5;outline:none;transition:border-color var(--m-dur) var(--m-ease)}',
      '.aic-compose textarea:focus{border-color:var(--green)}',
      '.aic-send{background:var(--green);color:#06140d;border:0;border-radius:12px;width:42px;height:40px;cursor:pointer;font-size:14px;transition:transform var(--m-dur-fast) var(--m-ease),opacity var(--m-dur-fast) var(--m-ease)}',
      '.aic-send:hover{transform:translateY(-1px)}.aic-send:active{transform:scale(.96)}.aic-send:disabled{opacity:.45;cursor:default;transform:none}',
      '.aic-hint{width:min(760px,100%);margin:8px auto 0;font-size:11px;color:var(--faint);text-align:center}',

      '/* ---------- pixel mascot ---------- */',
      '.aic-m{display:inline-block;line-height:0;flex:none}',
      '.aic-m-svg{width:38px;height:43px;display:block;shape-rendering:crispEdges;image-rendering:pixelated}',
      '.aic-m-svg rect{shape-rendering:crispEdges}',
      '.aic-px-o{fill:var(--bg)}',
      '.aic-px-l{fill:var(--green)}',
      '.aic-px-d{fill:#2c8f66}',
      '.aic-px-v{fill:#0b1520}',
      '.aic-px-e{fill:#eafff6}',
      '.aic-px-y{fill:var(--amber)}',
      '.aic-m-scan{fill:#eafff6;opacity:.75;transform:translateY(0);animation:aicScan var(--m-scan-dur) var(--m-ease) infinite}',
      '.aic-m-scan-b{opacity:.28;animation-delay:calc(var(--m-scan-dur) / -2)}',
      '@keyframes aicScan{0%{transform:translateY(0);opacity:0}12%{opacity:.7}50%{opacity:.25}88%{opacity:.7}100%{transform:translateY(22px);opacity:0}}',
      '.aic-m-wrap{animation:aicFloat var(--m-float-dur) var(--m-ease) infinite alternate}',
      '@keyframes aicFloat{from{transform:translateY(0)}to{transform:translateY(calc(var(--m-float-dist) * -1))}}',
      '.aic-m .aic-px-e{animation:aicBlink var(--m-blink-dur) steps(1,end) infinite;transform-box:fill-box;transform-origin:center}',
      '@keyframes aicBlink{0%,90%,100%{transform:scaleY(1)}93%,97%{transform:scaleY(.1)}}',
      '.aic-m .aic-px-y{animation:aicGlow var(--m-glow-dur) var(--m-ease) infinite alternate}',
      '@keyframes aicGlow{from{opacity:.45}to{opacity:1}}',
      '.aic-m{transition:transform var(--m-react-dur) var(--m-ease-spring)}',
      '.aic-m:hover{transform:scale(1.08) rotate(-2deg)}',
      '.aic-m:hover .aic-px-e{animation-duration:calc(var(--m-blink-dur) / 3)}',
      '.aic-m:hover .aic-px-y{opacity:1}',
      '.aic-m-hero{transform:scale(1.5);margin:6px 0}',
      '.aic-m-hero .aic-m-svg{width:58px;height:65px}',
      '.aic-m.thinking .aic-m-scan{animation-duration:calc(var(--m-scan-dur) / 3)}',
      '.aic-m.thinking .aic-px-e{animation-duration:calc(var(--m-blink-dur) / 4)}',

      '@media (max-width:820px){',
      '.aic-ws{grid-template-columns:1fr}',
      '.aic-rail{position:absolute;inset:0 auto 0 0;width:246px;z-index:2;transform:translateX(-100%);transition:transform var(--m-dur) var(--m-ease);box-shadow:var(--shadow)}',
      '.aic-ws.railed .aic-rail{transform:none}',
      '.aic-ws.railed::after{content:"";position:absolute;inset:0;background:rgba(0,0,0,.45)}',
      '.aic-msg{max-width:92%}',
      '}',
    ].join('\n');
    document.head.appendChild(css);
  }

  function build() {
    if (document.getElementById('aic-v2-css')) return;
    buildCSS();

    ball = document.createElement('button');
    ball.type = 'button'; ball.className = 'aic-ball'; ball.title = 'Open Infinite AI dashboard';
    ball.setAttribute('aria-label', 'Open Infinite AI dashboard');
    ball.innerHTML = '<i class="fa-solid fa-infinity"></i>';
    var side = document.querySelector('.sidebar');
    if (side) {
      ball.classList.add('aic-ball-side');
      var teamList = side.querySelector('.team-list-wrap');
      if (teamList) {
        ball.classList.add('aic-ball-team');
        side.insertBefore(ball, teamList);
      } else {
        side.insertBefore(ball, side.querySelector('.side-foot'));
      }
    } else {
      document.body.appendChild(ball);
    }

    ws = document.createElement('section');
    ws.className = 'aic-ws';
    ws.setAttribute('role', 'dialog');
    ws.setAttribute('aria-modal', 'true');
    ws.setAttribute('aria-label', 'Infinite AI');
    ws.innerHTML =
      '<aside class="aic-rail" id="aic-rail">' +
        '<div class="aic-rail-h">' + mascotSVG() +
          '<div><b>INFINITE AI</b><small>your life assistant</small></div></div>' +
        '<button type="button" class="aic-new" id="aic-new"><i class="fa-solid fa-plus"></i>New chat</button>' +
        '<div class="aic-rail-list" id="aic-rail-list"></div>' +
        '<div class="aic-rail-foot"><div class="aic-rail-who">Signed in as <b>—</b></div>' +
          '<div>AI can make mistakes. Check before you add.</div></div>' +
      '</aside>' +
      '<div class="aic-main">' +
        '<div class="aic-head">' + mascotSVG('aic-m-head') +
          '<div><h3>Infinite AI<small id="aic-head-sub">your life assistant · changes need your OK</small></h3></div>' +
          '<div class="aic-head-sp"></div>' +
          '<button type="button" id="aic-rail-toggle" title="Chats" aria-label="Toggle chat list"><i class="fa-solid fa-bars"></i></button>' +
          '<button type="button" id="aic-close" title="Close" aria-label="Close Infinite AI"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="aic-list" id="aic-list" aria-live="polite"><div class="aic-inner" id="aic-inner"></div></div>' +
        '<div class="aic-foot">' +
          '<div class="aic-sug" id="aic-sug"></div>' +
          '<div class="aic-compose"><textarea id="aic-input" rows="1" maxlength="2000" placeholder="Ask about your goals, or say what you want to achieve"></textarea>' +
          '<button type="button" class="aic-send" id="aic-send" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></div>' +
          '<div class="aic-hint">Enter to send · Shift+Enter for a new line</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ws);

    railEl = ws.querySelector('#aic-rail-list');
    list = ws.querySelector('#aic-inner');
    scroller = ws.querySelector('#aic-list');
    input = ws.querySelector('#aic-input');
    sendBtn = ws.querySelector('#aic-send');
    headMascot = ws.querySelector('.aic-m-head');

    ball.addEventListener('click', function () {
      if (!currentUser()) {
        document.dispatchEvent(new CustomEvent('lifeIsShortRequireSignIn'));
        return;
      }
      window.location.href = AI_DASHBOARD_URL;
    });
    ws.querySelector('#aic-close').addEventListener('click', close);
    ws.querySelector('#aic-rail-toggle').addEventListener('click', function () { ws.classList.toggle('railed'); });
    ws.querySelector('#aic-new').addEventListener('click', function () {
      if (busy) return;
      newChat(); input.focus();
    });
    sendBtn.addEventListener('click', function () { send(input.value); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (ws.classList.contains('railed')) { ws.classList.remove('railed'); return; }
        if (ws.classList.contains('open')) close();
      }
    });

    ws.addEventListener('click', function (e) {
      var sug = e.target.closest && e.target.closest('.aic-sug-i');
      if (sug) { send(sug.getAttribute('data-q')); return; }
      var del = e.target.closest && e.target.closest('.aic-chat-x');
      if (del) { e.stopPropagation(); deleteChat(del.getAttribute('data-del')); return; }
      var add = e.target.closest && e.target.closest('.aic-add');
      var skip = e.target.closest && e.target.closest('.aic-skip');
      var btn = add || skip;
      if (btn) {
        var chat = active();
        var a = chat.messages[+btn.dataset.m] && chat.messages[+btn.dataset.m].actions[+btn.dataset.a];
        if (!a || a.status !== 'pending') return;
        if (skip) { a.status = 'skipped'; }
        else {
          try { var r = applyAction(a); a.status = 'added'; toast(r); }
          catch (err) { a.status = 'could not add'; toast(err.message || 'Could not add'); }
        }
        chat.updated = Date.now();
        save(); render();
        return;
      }
      var item = e.target.closest && e.target.closest('.aic-chat');
      if (item && railEl.contains(item)) {
        activeId = item.getAttribute('data-id');
        ws.classList.remove('railed');
        save(); render(); input.focus();
      }
    });
    railEl.addEventListener('keydown', function (e) {
      var item = e.target.closest && e.target.closest('.aic-chat');
      if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); item.click(); }
    });
  }

  function syncVisibility() {
    if (!ball) return;
    var signedIn = !!currentUser();
    var guestMode = localStorage.getItem('lifeIsShort_mode') === 'guest';
    ball.classList.toggle('show', signedIn || guestMode);
    if (!signedIn) { close(); return; }
    if (loadedUid !== uid()) load();          // a different account: load that user's chats
    render();
  }

  function init() {
    if (ball) return;                       // never build two workspaces
    load(); build(); syncVisibility();
    document.addEventListener('lifeIsShortAuthState', syncVisibility);
    // auth.js may still be starting up when this script runs; check a few times.
    var tries = 0, t = setInterval(function () { syncVisibility(); if (currentUser() || ++tries > 20) clearInterval(t); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
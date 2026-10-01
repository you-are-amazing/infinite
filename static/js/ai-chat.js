/* Infinite AI — chat panel.
 * Self-contained: injects its own button, panel and CSS (uses your theme variables).
 * Talks to the `chat` Cloud Function. The AI only PROPOSES changes; nothing is saved until
 * the user presses Add on a card, and then it is written to localStorage in Infinite's own
 * formats, so the normal cloud sync picks it up.
 */
(function () {
  'use strict';
  var REGION = 'asia-south1';               // must match REGION in functions/index.js
  var STORE_KEY = 'infinite_ai_chat_v1';    // sessionStorage only: chat survives page changes, not closing the tab
  var MAX_SEND = 20;

  var messages = [];                         // {role:'user'|'model', text, actions?:[{id,name,args,status}]}
  var busy = false;
  var panel, list, input, sendBtn, fab, callable = null;

  /* ---------------- small helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Safe mini-markdown: escape first, then **bold**, "- " bullets, line breaks.
  function fmt(text) {
    var lines = esc(text).split('\n'), out = '', inList = false;
    lines.forEach(function (ln) {
      var m = ln.match(/^\s*[-*•]\s+(.*)$/);
      if (m) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + inline(m[1]) + '</li>'; }
      else {
        if (inList) { out += '</ul>'; inList = false; }
        out += ln.trim() ? '<p>' + inline(ln) + '</p>' : '';
      }
    });
    if (inList) out += '</ul>';
    return out;
    function inline(s) { return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }
  }
  function readJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function today() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function save() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-60))); } catch (e) {} }
  function load() { try { var v = JSON.parse(sessionStorage.getItem(STORE_KEY)); if (Array.isArray(v)) messages = v; } catch (e) {} }
  function currentUser() {
    return window.lifeIsShortUser || (window.lifeIsShortAuth && window.lifeIsShortAuth.currentUser) || null;
  }
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 1700);
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

  /* ---------------- rendering ---------------- */
  function render() {
    var user = currentUser();
    if (!user) {
      list.innerHTML = '<div class="aic-empty"><b>Sign in to use Infinite AI.</b>' +
        '<span>The assistant reads your goals and notes, so it needs your account. Guest mode keeps data only on this device.</span></div>';
      input.disabled = true; sendBtn.disabled = true;
      return;
    }
    input.disabled = false; sendBtn.disabled = busy;
    var html = '';
    if (!messages.length) {
      html += '<div class="aic-empty"><b>Hi' + (user.displayName ? ', ' + esc(user.displayName.split(' ')[0]) : '') + '. What are you working toward?</b>' +
        '<span>I can read your goals and notes, help you plan, and prepare changes for you to approve.</span>' +
        '<div class="aic-chips">' +
        ['What are my weekly goals?', 'Help me plan my year', 'Suggest goals for this week', 'Summarise my notes']
          .map(function (t) { return '<button type="button" class="aic-chip" data-q="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') +
        '</div></div>';
    }
    messages.forEach(function (m, mi) {
      html += '<div class="aic-msg ' + (m.role === 'user' ? 'me' : 'ai') + '">' + (m.role === 'user' ? '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>' : fmt(m.text)) + '</div>';
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
    list.scrollTop = list.scrollHeight;
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
    messages.push({ role: 'user', text: text.slice(0, 2000) });
    input.value = ''; autosize();
    busy = true; save(); render();
    var payload = messages.slice(-MAX_SEND).map(function (m) { return { role: m.role, text: m.text }; });
    var p;
    try { p = getCallable()({ messages: payload, today: today() }); } catch (e) { p = Promise.reject(e); }
    p.then(function (res) {
      var d = (res && res.data) || {};
      var acts = (d.proposed || []).map(function (a, i) { return { id: Date.now() + '-' + i, name: a.name, args: a.args, status: 'pending' }; });
      messages.push({ role: 'model', text: d.reply || '', actions: acts });
    }).catch(function (err) {
      console.warn('Infinite AI error', err);
      messages.push({ role: 'model', text: friendly(err) });
    }).then(function () { busy = false; save(); render(); input.focus(); });
  }

  /* ---------------- UI ---------------- */
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }
  function open() { panel.classList.add('open'); fab.setAttribute('aria-expanded', 'true'); render(); setTimeout(function () { input.focus(); }, 50); }
  function close() { panel.classList.remove('open'); fab.setAttribute('aria-expanded', 'false'); }

  function build() {
    var css = document.createElement('style');
    css.textContent = [
      '.aic-fab{position:fixed;right:20px;bottom:20px;z-index:900;width:52px;height:52px;border-radius:50%;border:1px solid var(--line);background:var(--surface,#0f1520);color:var(--green,#3ddc97);font-size:22px;cursor:pointer;box-shadow:var(--shadow);display:none;align-items:center;justify-content:center}',
      '.aic-fab.show{display:flex}.aic-fab:hover{border-color:var(--green,#3ddc97)}',
      'body:has(#inspire-rail) .aic-fab{right:384px}',
      '@media (max-width:1100px){body:has(#inspire-rail) .aic-fab{right:20px}}',
      '.aic-panel{position:fixed;right:16px;bottom:84px;z-index:950;width:390px;max-width:calc(100vw - 24px);height:min(600px,calc(100vh - 110px));background:var(--surface,#0f1520);color:var(--text,#e9eff7);border:1px solid var(--line,#223047);border-radius:var(--radius,14px);box-shadow:var(--shadow);display:none;flex-direction:column;overflow:hidden;font-family:inherit}',
      '.aic-panel.open{display:flex}',
      '.aic-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line-soft,#1b2637)}',
      '.aic-head h3{margin:0;font-size:15px;font-weight:700;flex:1}.aic-head small{display:block;font-weight:400;font-size:11.5px;color:var(--muted,#7e8ca3)}',
      '.aic-head button{background:none;border:0;color:var(--muted,#7e8ca3);cursor:pointer;font-size:14px;padding:6px 8px;border-radius:8px}.aic-head button:hover{color:var(--text,#e9eff7);background:var(--line-soft,#1b2637)}',
      '.aic-list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}',
      '.aic-msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.5;word-wrap:break-word}',
      '.aic-msg p{margin:0 0 6px}.aic-msg p:last-child{margin:0}.aic-msg ul{margin:4px 0 6px;padding-left:18px}',
      '.aic-msg.me{align-self:flex-end;background:var(--green-soft,rgba(61,220,151,.14));border:1px solid rgba(61,220,151,.25)}',
      '.aic-msg.ai{align-self:flex-start;background:var(--line-soft,#1b2637)}',
      '.aic-empty{margin:auto 0;display:flex;flex-direction:column;gap:8px;text-align:left;font-size:13.5px}.aic-empty b{font-size:16px}.aic-empty span{color:var(--muted,#7e8ca3);line-height:1.5}',
      '.aic-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.aic-chip{background:none;border:1px solid var(--line,#223047);color:var(--text,#e9eff7);border-radius:999px;padding:6px 11px;font-size:12.5px;cursor:pointer;font-family:inherit}.aic-chip:hover{border-color:var(--green,#3ddc97)}',
      '.aic-card{align-self:stretch;display:flex;align-items:center;gap:10px;border:1px solid var(--line,#223047);border-left:3px solid var(--lav,#8f8ff0);border-radius:10px;padding:9px 10px;background:var(--surface,#0f1520)}',
      '.aic-card[data-s=added]{border-left-color:var(--green,#3ddc97)}.aic-card[data-s=skipped]{opacity:.55}',
      '.aic-card-ic{color:var(--lav,#8f8ff0);width:18px;text-align:center}.aic-card[data-s=added] .aic-card-ic{color:var(--green,#3ddc97)}',
      '.aic-card-tx{flex:1;min-width:0;font-size:13px}.aic-card-tx small{display:block;color:var(--muted,#7e8ca3);font-size:11.5px;margin-bottom:1px}.aic-card-tx div{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
      '.aic-card-btns{display:flex;gap:6px}',
      '.aic-add,.aic-skip{font-family:inherit;font-size:12.5px;border-radius:8px;padding:5px 11px;cursor:pointer;border:1px solid var(--line,#223047);background:none;color:var(--text,#e9eff7)}',
      '.aic-add{background:var(--green,#3ddc97);border-color:var(--green,#3ddc97);color:#06140d;font-weight:600}',
      '.aic-card-done{font-size:12px;color:var(--muted,#7e8ca3)}',
      '.aic-typing{display:flex;gap:4px;padding:12px}.aic-typing span{width:6px;height:6px;border-radius:50%;background:var(--muted,#7e8ca3);animation:aicDot 1s infinite}.aic-typing span:nth-child(2){animation-delay:.15s}.aic-typing span:nth-child(3){animation-delay:.3s}',
      '@keyframes aicDot{0%,80%,100%{opacity:.25}40%{opacity:1}}',
      '.aic-foot{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line-soft,#1b2637);align-items:flex-end}',
      '.aic-foot textarea{flex:1;resize:none;max-height:120px;background:var(--bg,#0a0f16);color:var(--text,#e9eff7);border:1px solid var(--line,#223047);border-radius:10px;padding:9px 11px;font:inherit;font-size:13.5px;outline:none}.aic-foot textarea:focus{border-color:var(--green,#3ddc97)}',
      '.aic-send{background:var(--green,#3ddc97);color:#06140d;border:0;border-radius:10px;width:40px;height:38px;cursor:pointer;font-size:14px}.aic-send:disabled{opacity:.45;cursor:default}',
      '.aic-note{font-size:11px;color:var(--faint,#55637d);padding:0 12px 8px;text-align:center}',
      '@media (max-width:600px){.aic-panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100vh;border-radius:0}.aic-fab{bottom:16px}}'
    ].join('\n');
    document.head.appendChild(css);

    fab = document.createElement('button');
    fab.type = 'button'; fab.className = 'aic-fab'; fab.title = 'Infinite AI'; fab.setAttribute('aria-label', 'Open Infinite AI');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<i class="fa-solid fa-infinity"></i>';
    document.body.appendChild(fab);

    panel = document.createElement('section');
    panel.className = 'aic-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Infinite AI');
    panel.innerHTML =
      '<div class="aic-head"><h3>Infinite AI<small>Reads your goals and notes. Changes need your OK.</small></h3>' +
      '<button type="button" id="aic-new" title="New chat"><i class="fa-solid fa-rotate-right"></i></button>' +
      '<button type="button" id="aic-close" title="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="aic-list" id="aic-list" aria-live="polite"></div>' +
      '<div class="aic-foot"><textarea id="aic-input" rows="1" maxlength="2000" placeholder="Ask about your goals, or say what you want to achieve"></textarea>' +
      '<button type="button" class="aic-send" id="aic-send" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></div>' +
      '<div class="aic-note">AI can make mistakes. Check before you add.</div>';
    document.body.appendChild(panel);

    list = panel.querySelector('#aic-list'); input = panel.querySelector('#aic-input'); sendBtn = panel.querySelector('#aic-send');

    fab.addEventListener('click', function () { panel.classList.contains('open') ? close() : open(); });
    panel.querySelector('#aic-close').addEventListener('click', close);
    panel.querySelector('#aic-new').addEventListener('click', function () { if (busy) return; messages = []; save(); render(); });
    sendBtn.addEventListener('click', function () { send(input.value); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('open')) close(); });

    list.addEventListener('click', function (e) {
      var chip = e.target.closest && e.target.closest('.aic-chip');
      if (chip) { send(chip.getAttribute('data-q')); return; }
      var add = e.target.closest && e.target.closest('.aic-add');
      var skip = e.target.closest && e.target.closest('.aic-skip');
      var btn = add || skip;
      if (!btn) return;
      var a = messages[+btn.dataset.m] && messages[+btn.dataset.m].actions[+btn.dataset.a];
      if (!a || a.status !== 'pending') return;
      if (skip) { a.status = 'skipped'; }
      else {
        try { var r = applyAction(a); a.status = 'added'; toast(r); }
        catch (err) { a.status = 'could not add'; toast(err.message || 'Could not add'); }
      }
      save(); render();
    });
  }

  function syncVisibility() {
    if (!fab) return;
    var signedIn = !!currentUser();
    fab.classList.toggle('show', signedIn);
    if (!signedIn) close();
    else if (panel.classList.contains('open')) render();
  }

  function init() {
    if (fab) return;                       // never build two panels / two buttons
    load(); build(); syncVisibility();
    document.addEventListener('lifeIsShortAuthState', syncVisibility);
    // auth.js may still be starting up when this script runs; check a few times.
    var tries = 0, t = setInterval(function () { syncVisibility(); if (currentUser() || ++tries > 20) clearInterval(t); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
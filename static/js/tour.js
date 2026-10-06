/* Infinite - guided tour for new visitors.
 *
 * Flow: first visit (after sign-in / guest choice) -> "Want a tour? Yes / No".
 * Yes -> walks through Overview, Life Calendar, Notepad, Team Goals, Connect,
 * and finishes on the Infinite AI page. State is kept in localStorage so the
 * tour continues across pages and survives a reload.
 *
 * Replay any time from the "?" button in the top bar, or window.InfiniteTour.start().
 */
(function () {
  'use strict';

  var KEY_STATE = 'infinite_tour';        // 'declined' | 'done'  (absent = never asked)
  var KEY_STEP = 'infinite_tour_step';    // index of the step in progress (absent = not running)
  var MODE_KEY = 'lifeIsShort_mode';

  var SCRIPT_SRC = document.currentScript && document.currentScript.src;
  var ROOT = SCRIPT_SRC ? new URL('../../', SCRIPT_SRC).href : '/';

  var PAGES = {
    home: ROOT,
    calendar: ROOT + 'calendar/',
    notepad: ROOT + 'notepad/',
    team: ROOT + 'team/',
    contact: ROOT + 'contact/',
    ai: ROOT + 'ai/'
  };

  function currentPage() {
    var p = location.pathname.replace(/index\.html$/, '');
    if (/\/calendar\/?$/.test(p)) return 'calendar';
    if (/\/notepad\/?$/.test(p)) return 'notepad';
    if (/\/team\/?$/.test(p)) return 'team';
    if (/\/contact\/?$/.test(p)) return 'contact';
    if (/\/ai\/?$/.test(p)) return 'ai';
    if (/\/(admin)\/?$/.test(p)) return 'admin';
    return 'home';
  }

  /* ------------------------------------------------------------------ steps */
  // target: CSS selector (first visible match is used). No target / not visible = centred card.
  var STEPS = [
    { page: 'home', target: '.side-nav', place: 'right', icon: 'fa-compass',
      title: 'Your navigation',
      text: 'These are the five spaces of Infinite: Overview, Life Calendar, Notepad &amp; Docs, Team Goals and Connect. We will visit each one.' },
    { page: 'home', target: '.hero-card', place: 'bottom', icon: 'fa-hourglass-half',
      title: 'Your year at a glance',
      text: 'A live bar showing how much of this year is gone, how many days remain, and your pace. Time is finite, so this keeps it visible.' },
    { page: 'home', target: '.cards-grid', place: 'bottom', icon: 'fa-chart-pie',
      title: 'Year, month and week',
      text: 'Three progress rings that update on their own, so you always know where you stand right now.' },
    { page: 'home', target: '.vectors', place: 'top', icon: 'fa-layer-group',
      title: 'My Goals',
      text: 'Add daily, weekly, monthly and yearly goals here. Type a goal, press <b>+</b>, and tick it off when it is done.' },
    { page: 'home', target: '.sheet-panel', place: 'top', icon: 'fa-table',
      title: 'Life Sheet (habit tracker)',
      text: 'A spreadsheet-style tracker for habits. Add sheets, rows and columns, and colour cells to see your streaks.' },
    { page: 'home', target: '#sticky-bell-btn', place: 'bottom', icon: 'fa-thumbtack',
      title: 'Sticky notes',
      text: 'Pin important reminders here. The pin glows while something is still pending.' },
    { page: 'home', target: '#inspire-rail', place: 'left', icon: 'fa-lightbulb',
      title: 'Inspire Feed',
      text: 'Paste any <b>YouTube video or song link</b> that motivates you. Only its thumbnail shows in this box, and clicking it jumps straight to the video.' },

    { page: 'calendar', target: '.cal-controls', place: 'bottom', icon: 'fa-calendar-week',
      title: 'Life Calendar: set it up',
      text: 'Enter your birth date and expected lifespan, then press <b>Update Calendar</b>.' },
    { page: 'calendar', target: '.cal-grid-wrap', place: 'top', icon: 'fa-border-all',
      title: 'Every square is one week',
      text: 'Filled squares are weeks you have already lived, the highlighted one is this week, and the rest are still ahead of you.' },

    { page: 'notepad', target: '.np-side', place: 'right', icon: 'fa-book',
      title: 'Notepad &amp; Docs',
      text: 'Press <b>+ New note</b> to start writing. Your notes are listed here, and notes shared with a team show up under Team Docs.' },
    { page: 'notepad', target: '.np-main', place: 'left', icon: 'fa-pen-to-square',
      title: 'Rich text editor',
      text: 'Format and highlight your text here. Notes save automatically, locally for guests and to the cloud when you are signed in.' },

    { page: 'team', target: '.head-actions', place: 'bottom', icon: 'fa-users',
      title: 'Team Goals',
      text: '<b>Create a team</b> or <b>join one with an invite code</b>. Share goals, chat, and cheer each other on. Teams need a free account.' },

    { page: 'contact', target: '#cn-dev-card', place: 'right', icon: 'fa-envelope',
      title: 'Connect',
      text: 'Meet the developer of Infinite. Recruiters, builders and curious visitors are all welcome to say hello.' },
    { page: 'contact', target: '#cn-form', place: 'left', icon: 'fa-paper-plane',
      title: 'Send a message',
      text: 'Fill in your name, email and message. You can see, edit or delete your own messages afterwards.' },
    { page: 'contact', target: '.aic-ball', place: 'right', icon: 'fa-infinity', ai: 'enter',
      title: 'Last stop: Infinite AI',
      text: 'This <b>&infin;</b> button opens Infinite AI, your coaching companion. It reads your goals and notes, and only changes them after you approve.' },

    { page: 'ai', target: '.ax-comp', place: 'top', icon: 'fa-wand-magic-sparkles', ai: 'try',
      title: 'Now try it',
      text: 'Tell the AI what you want to achieve. It will suggest goals or notes, and nothing is added until you press the button to accept it.' },
    { page: 'ai', target: '.ax-side', place: 'right', icon: 'fa-clock-rotate-left',
      title: 'Your conversations',
      text: 'Every chat is saved here, so you can pick up where you left off or start a fresh one.' },
    { page: 'ai', target: null, icon: 'fa-flag-checkered', last: true,
      title: 'You are all set!',
      text: 'That is the whole of Infinite. Use the <b>?</b> button in the top bar any time to replay the tour. Now go make this time yours.' }
  ];

  /* ---------------------------------------------------------------- storage */
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  /* -------------------------------------------------------------------- css */
  function injectCSS() {
    if (document.getElementById('tour-css')) return;
    var s = document.createElement('style');
    s.id = 'tour-css';
    s.textContent = [
      '.tour-shield{position:fixed;inset:0;z-index:3000;background:transparent}',
      '.tour-shield.dim{background:rgba(5,8,13,.72);backdrop-filter:blur(2px)}',
      '.tour-spot{position:fixed;z-index:3001;border-radius:12px;pointer-events:none;box-shadow:0 0 0 9999px rgba(5,8,13,.72),0 0 0 2px var(--green,#3ddc97),0 0 24px 2px rgba(61,220,151,.45);transition:top .3s ease,left .3s ease,width .3s ease,height .3s ease,opacity .2s ease}',
      '.tour-card{position:fixed;z-index:3002;width:min(380px,calc(100vw - 24px));background:var(--surface,#0f1520);color:var(--text,#e9eff7);border:1px solid var(--line,#223047);border-radius:16px;padding:18px 18px 14px;box-shadow:0 18px 50px rgba(0,0,0,.55);font-family:inherit;animation:tourIn .25s ease}',
      '.tour-card.center{left:50%;top:50%;transform:translate(-50%,-50%)}',
      '@keyframes tourIn{from{opacity:0;margin-top:8px}to{opacity:1;margin-top:0}}',
      '.tour-ico{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--green-soft,rgba(61,220,151,.14));color:var(--green,#3ddc97);font-size:18px;flex:none}',
      '.tour-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}',
      '.tour-title{margin:0;font-size:17px;font-weight:700;line-height:1.25}',
      '.tour-text{margin:0 0 14px;font-size:14px;line-height:1.6;color:var(--muted,#7e8ca3)}',
      '.tour-text b{color:var(--text,#e9eff7)}',
      '.tour-bar{height:3px;border-radius:3px;background:var(--line-soft,#1b2637);overflow:hidden;margin-bottom:12px}',
      '.tour-bar i{display:block;height:100%;background:var(--green,#3ddc97);transition:width .3s ease}',
      '.tour-foot{display:flex;align-items:center;gap:8px}',
      '.tour-count{font-size:12px;color:var(--faint,#55637d);letter-spacing:.04em;margin-right:auto}',
      '.tour-btn{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:10px;border:1px solid var(--line,#223047);background:transparent;color:var(--text,#e9eff7);cursor:pointer;transition:border-color .15s,background .15s,filter .15s}',
      '.tour-btn:hover{border-color:var(--green,#3ddc97)}',
      '.tour-btn.primary{background:var(--green,#3ddc97);border-color:var(--green,#3ddc97);color:#06140d}',
      '.tour-btn.primary:hover{filter:brightness(1.08)}',
      '.tour-btn.quiet{border-color:transparent;color:var(--muted,#7e8ca3);padding-left:6px;padding-right:6px}',
      '.tour-btn.quiet:hover{color:var(--text,#e9eff7);border-color:transparent}',
      '.tour-btn:focus-visible{outline:2px solid var(--green,#3ddc97);outline-offset:2px}',
      '.tour-ask{width:min(440px,calc(100vw - 24px));padding:26px 24px 20px;text-align:center}',
      '.tour-ask .tour-ico{width:58px;height:58px;font-size:26px;margin:0 auto 14px;border-radius:18px}',
      '.tour-ask .tour-title{font-size:21px;margin-bottom:8px}',
      '.tour-ask .tour-text{font-size:14.5px}',
      '.tour-ask .tour-foot{flex-direction:column;align-items:stretch;gap:8px}',
      '.tour-ask .tour-btn{padding:11px 14px;font-size:14px}',
      '.tour-help-btn{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--line,#223047);background:var(--surface,#0f1520);color:var(--muted,#7e8ca3);cursor:pointer;font-size:15px;margin-right:8px;transition:color .15s,border-color .15s}',
      '.tour-help-btn:hover{color:var(--green,#3ddc97);border-color:var(--green,#3ddc97)}',
      '.tour-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:3003;background:var(--surface2,#141c2b);color:var(--text,#e9eff7);border:1px solid var(--line,#223047);border-radius:12px;padding:11px 16px;font-size:13.5px;box-shadow:0 10px 30px rgba(0,0,0,.4);max-width:calc(100vw - 24px)}',
      '@media (max-width:600px){.tour-card:not(.center):not(.tour-ask){left:12px!important;right:12px;top:auto!important;bottom:12px;width:auto}}',
      '@media (prefers-reduced-motion:reduce){.tour-spot,.tour-bar i{transition:none}.tour-card{animation:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ utils */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function isVisible(n) {
    if (!n) return false;
    var r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var cs = getComputedStyle(n);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function findTarget(sel) {
    if (!sel) return null;
    var list = document.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) if (isVisible(list[i])) return list[i];
    return null;
  }

  function authReady() {
    var overlay = document.getElementById('auth-overlay');
    if (overlay && !overlay.hidden) return false;
    if (document.body.classList.contains('auth-lock')) return false;
    return get(MODE_KEY) === 'guest' || !!window.lifeIsShortUser;
  }

  function isSignedIn() { return !!window.lifeIsShortUser; }

  function toast(msg) {
    var t = el('div', 'tour-toast', msg);
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
  }

  /* -------------------------------------------------------------- the tour */
  var ui = null;        // { shield, spot, card }
  var idx = -1;
  var rafId = 0;
  var keyHandler = null;

  function teardown() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (ui) { ['shield', 'spot', 'card'].forEach(function (k) { if (ui[k]) ui[k].remove(); }); }
    ui = null;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  }

  function finish(markDone) {
    teardown();
    del(KEY_STEP);
    if (markDone !== false) set(KEY_STATE, 'done');
  }

  function firstStepOf(page) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].page === page) return i;
    return -1;
  }

  function goTo(n) {
    if (n < 0) n = 0;
    if (n >= STEPS.length) { finish(true); return; }
    var step = STEPS[n];
    if (step.page !== currentPage()) {
      set(KEY_STEP, String(n));
      teardown();
      location.href = PAGES[step.page];
      return;
    }
    show(n);
  }

  function show(n) {
    idx = n;
    set(KEY_STEP, String(n));
    var step = STEPS[n];
    injectCSS();

    if (!ui) {
      ui = { shield: el('div', 'tour-shield'), spot: el('div', 'tour-spot'), card: null };
      document.body.appendChild(ui.shield);
      document.body.appendChild(ui.spot);
      keyHandler = function (e) {
        if (!ui) return;
        if (e.key === 'Escape') { e.preventDefault(); finish(true); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { if (document.activeElement && document.activeElement.classList.contains('tour-btn')) return; e.preventDefault(); next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(idx - 1); }
      };
      document.addEventListener('keydown', keyHandler, true);
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
    }

    if (ui.card) ui.card.remove();
    var card = el('div', 'tour-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Infinite tour');

    var total = STEPS.length;
    var pct = Math.round(((n + 1) / total) * 100);
    var isLast = n === total - 1 || step.last;
    var text = step.text;
    var primaryLabel = isLast ? 'Finish' : 'Next';
    var secondary = null;

    if (step.ai === 'enter') {
      if (isSignedIn()) {
        primaryLabel = 'Open Infinite AI';
      } else {
        text += ' <b>AI needs a free account</b>, so sign in first to try it.';
        primaryLabel = 'Sign in to try AI';
      }
    }
    if (step.ai === 'try') {
      secondary = { label: 'Fill an example', run: fillExample };
    }

    card.innerHTML =
      '<div class="tour-head"><div class="tour-ico"><i class="fa-solid ' + step.icon + '"></i></div>' +
      '<h3 class="tour-title">' + step.title + '</h3></div>' +
      '<p class="tour-text">' + text + '</p>' +
      '<div class="tour-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="tour-foot">' +
      '<span class="tour-count">' + (n + 1) + ' / ' + total + '</span>' +
      (isLast ? '' : '<button type="button" class="tour-btn quiet" data-a="skip">Skip tour</button>') +
      (n > 0 && !isLast ? '<button type="button" class="tour-btn" data-a="back">Back</button>' : '') +
      (secondary ? '<button type="button" class="tour-btn" data-a="alt">' + secondary.label + '</button>' : '') +
      '<button type="button" class="tour-btn primary" data-a="next">' + primaryLabel + '</button>' +
      '</div>';
    document.body.appendChild(card);
    ui.card = card;

    card.addEventListener('click', function (e) {
      var b = e.target.closest('[data-a]');
      if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'skip') finish(true);
      else if (a === 'back') goTo(idx - 1);
      else if (a === 'alt' && secondary) secondary.run();
      else if (a === 'next') next();
    });
    var nb = card.querySelector('[data-a="next"]');
    if (nb) nb.focus({ preventScroll: true });

    var target = findTarget(step.target);
    if (target) {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      ui.spot.style.opacity = '1';
      ui.shield.classList.remove('dim');
      setTimeout(reposition, 60);
      setTimeout(reposition, 380);
    } else {
      ui.spot.style.opacity = '0';
      ui.shield.classList.add('dim');
    }
    reposition();
  }

  function reposition() {
    if (!ui || !ui.card || idx < 0) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(layout);
  }

  function layout() {
    rafId = 0;
    if (!ui || !ui.card) return;
    var step = STEPS[idx];
    var card = ui.card;
    var target = findTarget(step.target);

    if (!target) {
      ui.spot.style.opacity = '0';
      ui.shield.classList.add('dim');
      card.classList.add('center');
      card.style.left = card.style.top = '';
      return;
    }
    card.classList.remove('center');
    ui.shield.classList.remove('dim');

    var pad = 8;
    var r = target.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var sl = Math.max(4, r.left - pad), sr = Math.min(vw - 4, r.right + pad);
    var st = Math.max(4, r.top - pad), sb = Math.min(vh - 4, r.bottom + pad);
    ui.spot.style.cssText = 'opacity:1;top:' + st + 'px;left:' + sl + 'px;width:' + Math.max(0, sr - sl) + 'px;height:' + Math.max(0, sb - st) + 'px';

    var rr = { left: sl, right: sr, top: st, bottom: sb, width: sr - sl, height: sb - st };
    r = rr;
    var cw = card.offsetWidth, ch = card.offsetHeight, gap = 16;
    var place = step.place || 'bottom';
    var cx, cy;

    function fits(p) {
      if (p === 'right') return r.right + gap + cw <= vw - 8;
      if (p === 'left') return r.left - gap - cw >= 8;
      if (p === 'bottom') return r.bottom + gap + ch <= vh - 8;
      return r.top - gap - ch >= 8;
    }
    var order = [place, 'bottom', 'top', 'right', 'left'];
    var chosen = null;
    for (var i = 0; i < order.length; i++) if (fits(order[i])) { chosen = order[i]; break; }

    if (!chosen) {
      // target is huge (or screen tiny): float the card over the lower part of the screen
      cx = (vw - cw) / 2; cy = vh - ch - 16;
    } else if (chosen === 'right') { cx = r.right + gap; cy = r.top + r.height / 2 - ch / 2; }
    else if (chosen === 'left') { cx = r.left - gap - cw; cy = r.top + r.height / 2 - ch / 2; }
    else if (chosen === 'bottom') { cx = r.left + r.width / 2 - cw / 2; cy = r.bottom + gap; }
    else { cx = r.left + r.width / 2 - cw / 2; cy = r.top - gap - ch; }

    cx = Math.max(8, Math.min(cx, vw - cw - 8));
    cy = Math.max(8, Math.min(cy, vh - ch - 8));
    card.style.left = cx + 'px';
    card.style.top = cy + 'px';
  }

  function fillExample() {
    var ta = document.getElementById('ax-input');
    if (!ta) return;
    ta.value = 'Help me plan this week and suggest three goals I can finish.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    toast('Example added. Press Enter or the send button when you are ready.');
  }

  function next() {
    var step = STEPS[idx];
    if (step && step.ai === 'enter') {
      if (!isSignedIn()) {
        // keep the tour state at the AI step; the site's own sign-in prompt opens
        finish(false);
        set(KEY_STEP, String(idx));
        document.dispatchEvent(new CustomEvent('lifeIsShortRequireSignIn'));
        return;
      }
      goTo(idx + 1);   // navigates to the AI page and carries the tour along
      return;
    }
    if (idx >= STEPS.length - 1 || (step && step.last)) { finish(true); return; }
    goTo(idx + 1);
  }

  /* ------------------------------------------------------------ first-visit */
  function askToStart() {
    injectCSS();
    var shield = el('div', 'tour-shield dim');
    var card = el('div', 'tour-card tour-ask center');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-ask-title');
    card.innerHTML =
      '<div class="tour-ico"><i class="fa-solid fa-infinity"></i></div>' +
      '<h3 class="tour-title" id="tour-ask-title">New to Infinite?</h3>' +
      '<p class="tour-text">Want a quick tour? We will walk you through every page one by one, and finish by trying <b>Infinite AI</b>. It takes about two minutes.</p>' +
      '<div class="tour-foot">' +
      '<button type="button" class="tour-btn primary" data-a="yes">Yes, show me around</button>' +
      '<button type="button" class="tour-btn quiet" data-a="no">No, thanks</button>' +
      '</div>';
    document.body.appendChild(shield);
    document.body.appendChild(card);
    card.querySelector('[data-a="yes"]').focus();

    function close() { shield.remove(); card.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); decline(); } }
    function decline() {
      close();
      set(KEY_STATE, 'declined');
      toast('No problem. You can start the tour any time from the <b>?</b> button at the top.');
    }
    document.addEventListener('keydown', onKey, true);
    card.addEventListener('click', function (e) {
      var b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.getAttribute('data-a') === 'yes') { close(); start(); }
      else decline();
    });
  }

  function start() {
    teardown();
    del(KEY_STATE);
    if (currentPage() !== 'home') { set(KEY_STEP, '0'); location.href = PAGES.home; return; }
    show(0);
  }

  /* ----------------------------------------------------------- help button */
  function addHelpButton() {
    if (document.getElementById('tour-help-btn')) return;
    var holder = document.querySelector('.top-actions');
    if (!holder) return;
    injectCSS();
    var b = el('button', 'tour-help-btn', '<i class="fa-solid fa-circle-question"></i>');
    b.type = 'button';
    b.id = 'tour-help-btn';
    b.title = 'Take a tour of Infinite';
    b.setAttribute('aria-label', 'Take a tour of Infinite');
    b.addEventListener('click', start);
    holder.insertBefore(b, holder.firstChild);
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    var page = currentPage();
    if (page === 'admin') return;
    addHelpButton();

    var saved = get(KEY_STEP);
    var state = get(KEY_STATE);
    var running = saved !== null && saved !== '' && !isNaN(parseInt(saved, 10));
    var tries = 0;

    var timer = setInterval(function () {
      tries++;
      // wait for sign-in / guest choice, but give up eventually
      if (!authReady()) { if (tries > 240) clearInterval(timer); return; }
      clearInterval(timer);

      if (running) {
        var n = parseInt(saved, 10);
        if (n < 0 || n >= STEPS.length) { del(KEY_STEP); return; }
        if (STEPS[n].page !== page) {
          var f = firstStepOf(page);
          if (f < 0) return;     // a page the tour does not cover: stay quiet
          n = f;
        }
        setTimeout(function () { show(n); }, 400);
      } else if (!state && page === 'home') {
        setTimeout(askToStart, 700);
      }
    }, 500);
  }

  window.InfiniteTour = { start: start, stop: function () { finish(false); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* Inspire Feed — right-side rail.
   MY LINKS only: paste any YouTube video/song link; only the thumbnail shows in the
   box, and clicking the thumbnail opens the video on YouTube. While empty, the
   box asks you to paste a link that motivates you.
   (Stories, Songs and the Google News link were removed.) */
(function () {
  'use strict';
  const LINKS_KEY = 'life_inspire_links';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- YouTube link helpers ---------- */
  function ytId(url) {
    const m = String(url || '').trim().match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  function readLinks() {
    try { const v = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function saveLinks(v) { localStorage.setItem(LINKS_KEY, JSON.stringify(v)); }

  function mount() {
    let rail = document.getElementById('inspire-rail');
    if (rail) return rail;
    const setTb = () => { const tb = document.querySelector('.topbar'); if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px'); };
    setTb(); window.addEventListener('resize', setTb);
    const tbEl = document.querySelector('.topbar'); if (tbEl && window.ResizeObserver) new ResizeObserver(setTb).observe(tbEl);
    const page = document.querySelector('.main-wrap > .page');
    if (!page) return null;
    const layout = document.createElement('div');
    layout.className = 'page-layout';
    page.parentNode.insertBefore(layout, page);
    layout.appendChild(page);
    rail = document.createElement('aside');
    rail.id = 'inspire-rail'; rail.className = 'inspire-rail';
    rail.innerHTML = `<div class="ins-head"><div class="ins-title"><span class="ico"><i class="fa-solid fa-lightbulb"></i></span>
        <h3>Inspire Feed<small>Your motivation, one click away</small></h3></div></div>
      <div class="ins-tabs">
        <button class="ins-tab on" type="button">MY LINKS (YOUTUBE ONLY)</button>
      </div>
      <div class="ins-body" id="ins-body"></div><div class="ins-foot" id="ins-foot"></div>`;
    layout.appendChild(rail);
    return rail;
  }

  function draw(focusInput) {
    if (!mount()) return;
    const body = document.getElementById('ins-body'), foot = document.getElementById('ins-foot');
    if (!body) return;
    drawLinks(body, foot, focusInput);
  }

  /* ---------- MY LINKS ---------- */
  function drawLinks(body, foot, focusInput) {
    const links = readLinks();
    let html = `<div class="ins-add-row">
        <input id="ins-link-input" type="text" inputmode="url" placeholder="Paste a YouTube video / song link…" maxlength="300" aria-label="YouTube link">
        <button id="ins-link-add" class="ins-add-btn" type="button">Add</button>
      </div>`;
    if (!links.length) {
      html += `<div class="ins-empty"><i class="fa-brands fa-youtube" style="font-size:28px;color:var(--red)"></i><br>
        <b>Nothing here yet.</b><br>
        Paste a YouTube link that motivates you, a workout mix, a speech, a song and only its thumbnail will show in this box. Click the thumbnail anytime to jump straight to the video.</div>`;
    } else {
      html += '<div class="ins-links-grid">' + links.map(l =>
        `<div class="ins-link-card">
           <a class="ins-thumb" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="Open on YouTube"
              style="background-image:url('https://i.ytimg.com/vi/${esc(l.vid)}/hqdefault.jpg')">
             <span class="ins-play-overlay"><i class="fa-solid fa-play"></i></span>
           </a>
           <button class="ins-link-del" data-del="${esc(l.id)}" aria-label="Remove link" title="Remove">×</button>
         </div>`).join('') + '</div>';
    }
    body.innerHTML = html;
    foot.innerHTML = 'Your private picks saved on this device, synced when signed in';

    const input = document.getElementById('ins-link-input');
    const add = () => {
      const url = input.value.trim();
      const vid = ytId(url);
      if (!vid) {
        input.classList.add('ins-err');
        setTimeout(() => input.classList.remove('ins-err'), 500);
        input.focus();
        return;
      }
      const list = readLinks();
      if (list.some(x => x.vid === vid)) { input.value = ''; input.focus(); return; }
      list.unshift({ id: String(Date.now()) + '_' + vid, vid: vid, url: 'https://www.youtube.com/watch?v=' + vid, addedAt: new Date().toISOString() });
      saveLinks(list);
      input.value = '';
      drawLinks(body, foot, true);
    };
    document.getElementById('ins-link-add').onclick = add;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      saveLinks(readLinks().filter(x => String(x.id) !== String(b.dataset.del)));
      drawLinks(body, foot);
    });
    if (focusInput) input.focus();
  }

  // Redraw when the links change from elsewhere (cloud sync), without disturbing typing.
  let timer;
  const origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    origSet(k, v);
    if (k === LINKS_KEY) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const inp = document.getElementById('ins-link-input');
        if (!inp || (!inp.value && document.activeElement !== inp)) draw();
      }, 1200);
    }
  };
  document.addEventListener('lifeIsShortDataReady', () => draw());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => draw());
  else draw();
})();
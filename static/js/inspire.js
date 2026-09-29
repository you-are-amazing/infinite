/* Inspire Feed — right-side rail.
   MY LINKS: paste any YouTube video/song link; only the thumbnail shows in the
   box, and clicking the thumbnail opens the video on YouTube. While empty, the
   box asks you to paste a link that motivates you.
   STORIES: motivational news from the static JSON feed.
   SONGS: 30-second previews via the free iTunes Search API. */
(function () {
  'use strict';
  const LINKS_KEY = 'life_inspire_links';
  const STOP = new Set('the and for with from this that your have will just make some into about than then them what when want need get got add set new day week month year done todo complete completed'.split(' '));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const audio = new Audio();
  let tab = 'links', cache = { news: null, songs: null, kw: '' }, playingBtn = null;

  function userText() {
    let t = '';
    try { t += JSON.parse(localStorage.getItem('goals') || '[]').filter(g => !g.done).map(g => g.text).join(' '); } catch (e) {}
    try { t += ' ' + JSON.parse(localStorage.getItem('life_sticky_notes') || '[]').map(n => n.text || n.title || '').join(' '); } catch (e) {}
    return t.toLowerCase();
  }
  function keywords(text) {
    const f = {};
    text.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).forEach(w => { if (w.length > 2 && !STOP.has(w)) f[w] = (f[w] || 0) + 1; });
    return Object.entries(f).sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 6);
  }
  const score = (i, kws) => { const h = (i.title + ' ' + (i.topics || []).join(' ') + ' ' + (i.summary || '')).toLowerCase(); return kws.reduce((s, k) => s + (h.includes(k) ? ((i.topics || []).includes(k) ? 3 : 1) : 0), 0); };

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
    rail.innerHTML = `<div class="ins-head"><div class="ins-title"><span class="ico"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
        <h3>Inspire Feed<small>Picked for your goals</small></h3><button class="ins-refresh" id="ins-refresh" aria-label="Refresh feed" title="Refresh"><i class="fa-solid fa-rotate"></i></button></div></div>
      <div class="ins-tabs">
        <button class="ins-tab on" data-tab="links">MY LINKS</button>
        <button class="ins-tab" data-tab="stories">STORIES</button>
        <button class="ins-tab" data-tab="songs">SONGS</button>
      </div>
      <div class="ins-body" id="ins-body"></div><div class="ins-foot" id="ins-foot"></div>`;
    layout.appendChild(rail);
    rail.querySelector('#ins-refresh').onclick = () => { if (tab === 'links') draw(); else load(true); };
    rail.querySelectorAll('.ins-tab').forEach(b => b.onclick = () => {
      tab = b.dataset.tab;
      rail.querySelectorAll('.ins-tab').forEach(x => x.classList.toggle('on', x === b));
      draw();
    });
    return rail;
  }

  async function load(force) {
    if (!mount()) return;
    const kws = keywords(userText()), key = kws.join(',');
    if (!force && cache.kw === key && cache.news) return draw();
    cache.kw = key;
    document.getElementById('ins-body').innerHTML = '<div class="ins-skel"></div><div class="ins-skel"></div><div class="ins-skel"></div>';
    let items = [];
    try { items = (await (await fetch('static/data/news.json?t=' + Date.now())).json()).items || []; } catch (e) {}
    cache.news = items.map(i => ({ i, s: score(i, kws) })).sort((a, b) => b.s - a.s || new Date(b.i.published) - new Date(a.i.published)).slice(0, 10);
    try { cache.songs = (await (await fetch('https://itunes.apple.com/search?entity=song&limit=10&term=' + encodeURIComponent((kws[0] ? kws[0] + ' ' : '') + 'motivation'))).json()).results || []; } catch (e) { cache.songs = []; }
    cache.kws = kws;
    draw();
  }

  function draw() {
    if (!mount()) return;                       // FIX: build the rail even when My Links is the first tab
    const body = document.getElementById('ins-body'), foot = document.getElementById('ins-foot');
    if (!body) return;
    audio.pause(); playingBtn = null;
    if (tab === 'links') return drawLinks(body, foot);
    if (!cache.news) { load(); return; }
    const q = encodeURIComponent((cache.kws.slice(0, 2).join(' ') || 'motivation') + ' success story');
    if (tab === 'stories') {
      body.innerHTML = cache.news.length ? cache.news.map(({ i, s }) => `<a class="ins-story" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">
          <b>${esc(i.title)}</b>${i.why ? `<p>${esc(i.why)}</p>` : ''}
          <div class="ins-meta">${s > 0 ? '<span class="ins-badge">Matches your goals</span>' : ''}<span>${esc(i.source)}</span></div></a>`).join('')
        : `<div class="ins-empty"><i class="fa-regular fa-newspaper" style="font-size:22px;color:var(--faint)"></i><br><b>No stories yet.</b><br>Fresh stories matched to your goals show up here after the daily feed update (run <b>Update inspire feed</b> dev. working on it).<br><br>Want something to lift you right now? Open <b>My Links</b> and paste a YouTube video or song that motivates you.</div>`;
      foot.innerHTML = `<a href="https://news.google.com/search?q=${q}" target="_blank" rel="noopener noreferrer">Search Google News for your goals →</a>`;
    } else {
      body.innerHTML = cache.songs.length ? cache.songs.map((t, n) => `<div class="ins-song">
          <div class="ins-art" style="background-image:url('${esc(t.artworkUrl100)}')"></div>
          <div class="txt"><b>${esc(t.trackName)}</b><span>${esc(t.artistName)}</span><div class="ins-bar"><i id="bar${n}"></i></div></div>
          <button class="ins-play" data-n="${n}" aria-label="Play preview"><i class="fa-solid fa-play"></i></button></div>`).join('')
        : '<div class="ins-empty">Songs are unavailable right now. Check your connection and refresh.</div>';
      body.querySelectorAll('.ins-play').forEach(b => b.onclick = () => play(b));
      foot.innerHTML = '30-second previews · via iTunes';
    }
  }

  /* ---------- MY LINKS tab ---------- */
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
              style="background-image:url('https://i.ytimg.com/vi/${l.vid}/hqdefault.jpg')">
             <span class="ins-play-overlay"><i class="fa-solid fa-play"></i></span>
           </a>
           <button class="ins-link-del" data-del="${l.id}" aria-label="Remove link" title="Remove">×</button>
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

  function play(btn) {
    const t = cache.songs[btn.dataset.n];
    if (playingBtn === btn && !audio.paused) { audio.pause(); return; }
    if (playingBtn) playingBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playingBtn = btn; audio.src = t.previewUrl; audio.play();
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    audio.ontimeupdate = () => { const b = document.getElementById('bar' + btn.dataset.n); if (b && audio.duration) b.style.width = (audio.currentTime / audio.duration * 100) + '%'; };
    audio.onpause = audio.onended = () => { btn.innerHTML = '<i class="fa-solid fa-play"></i>'; };
  }

  let timer;
  const origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { origSet(k, v); if (k === 'goals' || k === 'life_sticky_notes' || k === LINKS_KEY) { clearTimeout(timer); timer = setTimeout(() => { const inp = document.getElementById('ins-link-input'); if (tab === 'links') { if (!inp || (!inp.value && document.activeElement !== inp)) draw(); } else load(); }, 1200); } };
  document.addEventListener('lifeIsShortDataReady', () => { if (tab === 'links') draw(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => draw());
  else draw();
})();

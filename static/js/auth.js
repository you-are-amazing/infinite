/*
 * Firebase Console setup:
 * 1. Create a Firebase project and register this GitHub Pages web app.
 * 2. Enable Authentication > Sign-in method > Email/Password.
 * 3. Create a Firestore database in production mode.
 * 4. Paste the Firebase web config below, then publish the site.
 * 5. Set Firestore rules so each user can only read/write users/{uid}/...
 *    (for example: allow read, write: if request.auth.uid == userId;).
 *
 * Firebase web config is intended to be public. Security rules protect the data.
 */

const firebaseConfig = {
  apiKey: 'AIzaSyDeodSvLLTFPr0dqmddU0WeFvy0fIVpHd8',
  authDomain: 'life-is-short-bcf81.firebaseapp.com',
  projectId: 'life-is-short-bcf81',
  storageBucket: 'life-is-short-bcf81.firebasestorage.app',
  messagingSenderId: '987052092105',
  appId: '1:987052092105:web:4dab5998d8ae08d2cb7b18',
  measurementId: 'G-E884ZY30FP'
};

const LIFE_IS_SHORT_MODE_KEY = 'lifeIsShort_mode';
const LIFE_IS_SHORT_NAME_KEY = 'life_user_name';
const LIFE_IS_SHORT_DATA_KEYS = [
  'goals',
  'life_sheet_data_v2',
  'life_sheet_active_index',
  'calendarBirthdate',
  'calendarLifespan',
  'life_notes',
  'life_note_links',
  'life_highlight_color',
  'life_sticky_notes',
  'life_sticky_glow_enabled',
  'life_inspire_links',
  'theme'
];

let lifeIsShortAuth = null;
let lifeIsShortDb = null;
let lifeIsShortUser = null;
let isHydratingLifeIsShortData = false;
let syncTimer = null;

function firebaseConfigIsReady() {
  return !Object.values(firebaseConfig).some((value) => value.startsWith('PASTE_'));
}

function getStoredLifeIsShortData() {
  return LIFE_IS_SHORT_DATA_KEYS.reduce((data, key) => {
    const value = localStorage.getItem(key);
    if (value !== null) data[key] = value;
    return data;
  }, {});
}

function applyLifeIsShortData(data) {
  isHydratingLifeIsShortData = true;
  LIFE_IS_SHORT_DATA_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(data || {}, key)) {
      localStorage.setItem(key, data[key]);
    }
  });
  isHydratingLifeIsShortData = false;
  document.dispatchEvent(new CustomEvent('lifeIsShortDataReady'));
}

function scheduleLifeIsShortSync() {
  if (!lifeIsShortUser || !lifeIsShortDb || isHydratingLifeIsShortData) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await lifeIsShortDb.collection('users').doc(lifeIsShortUser.uid).set(
        { data: getStoredLifeIsShortData(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (error) {
      console.warn('Unable to sync Infinite data', error);
    }
  }, 500);
}

function setupLifeIsShortStorageSync() {
  const originalSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    originalSetItem(key, value);
    if (LIFE_IS_SHORT_DATA_KEYS.includes(key)) scheduleLifeIsShortSync();
  };
}

function setAuthOverlayVisible(isVisible) {
  const overlay = document.getElementById('auth-overlay');
  if (!overlay) return;
  overlay.hidden = !isVisible;
  document.body.classList.toggle('auth-lock', isVisible);
  if (isVisible) AuthPixels.start(); else AuthPixels.stop();
}

function updateSiteGreeting() {
  const greeting = document.getElementById('site-greeting');
  if (!greeting) return;
  greeting.textContent = 'Infinite';
}

function setAuthError(message) {
  const error = document.getElementById('auth-error');
  if (error) error.textContent = message || '';
}

function readableAuthError(error) {
  const messages = {
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/user-not-found': 'No account was found for that email.',
    'auth/wrong-password': 'That password is incorrect.',
    'auth/invalid-credential': 'The email or password is incorrect.',
    'auth/email-already-in-use': 'An account already uses that email.',
    'auth/weak-password': 'Use a stronger password with at least 6 characters.',
    'auth/requires-recent-login': 'Please sign in again before changing your password.',
    'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
    'auth/missing-email': 'Enter your email address.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/network-request-failed': 'Network problem. Check your connection and try again.',
    'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups and try again.',
    'auth/account-exists-with-different-credential': 'An account already exists with that email using a different sign-in method.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled yet in Firebase.',
    'auth/unauthorized-domain': 'This website is not authorised for Google sign-in yet. Add it under Firebase > Authentication > Settings > Authorized domains.'
  };
  return messages[error.code] || 'Something went wrong. Please try again.';
}

function showPasswordReminder() {
  alert('Please keep your password somewhere safe. If you ever forget it, use "Forgot password?" on the sign-in page.');
}

function setAccountActions(user) {
  const guestNotice = document.getElementById('guest-mode-notice');
  if (guestNotice) {
    guestNotice.hidden = Boolean(user) || localStorage.getItem(LIFE_IS_SHORT_MODE_KEY) !== 'guest';
  }

  const actions = document.getElementById('auth-account-actions');
  if (!actions) return;
  actions.hidden = false;
  const name = (user?.displayName || localStorage.getItem(LIFE_IS_SHORT_NAME_KEY) || '').trim();
  const label = user ? (name || user.email) : (name ? `${name} (Guest Mode)` : 'Guest Mode');
  actions.innerHTML = '';

  const accountLabel = document.createElement('span');
  accountLabel.className = 'auth-account-label';
  accountLabel.textContent = label;
  actions.appendChild(accountLabel);

  if (user) {
    const passwordButton = document.createElement('button');
    passwordButton.type = 'button';
    passwordButton.className = 'auth-inline-button';
    passwordButton.textContent = 'Change password';
    passwordButton.addEventListener('click', showPasswordForm);
    if (hasPasswordProvider(user)) actions.appendChild(passwordButton);

    const logoutButton = document.createElement('button');
    logoutButton.type = 'button';
    logoutButton.className = 'auth-inline-button';
    logoutButton.textContent = 'Log out';
    logoutButton.addEventListener('click', async () => {
      logoutButton.disabled = true;
      try {
        await lifeIsShortAuth.signOut();
      } catch (error) {
        logoutButton.disabled = false;
        setAuthError(readableAuthError(error));
      }
    });
    actions.appendChild(logoutButton);
  } else {
    const signupButton = document.createElement('button');
    signupButton.type = 'button';
    signupButton.className = 'auth-inline-button';
    signupButton.textContent = 'Sign up to sync';
    signupButton.addEventListener('click', () => {
      showAuthForm('signup');
      setAuthOverlayVisible(true);
    });
    actions.appendChild(signupButton);
  }
}

function showPasswordForm() {
  const dialog = document.getElementById('password-dialog');
  if (!dialog) return;
  dialog.showModal();
  document.getElementById('current-password')?.focus();
}

function setupPasswordForm() {
  const form = document.getElementById('password-form');
  const dialog = document.getElementById('password-dialog');
  if (!form || !dialog) return;
  const pwWarning = dialog.querySelector('.auth-password-warning');
  if (pwWarning) pwWarning.textContent = 'Please keep your new password somewhere safe. If you forget it, use "Forgot password?" on the sign-in page.';

  document.getElementById('password-cancel')?.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const error = document.getElementById('password-error');
    error.textContent = '';

    if (newPassword.length < 6) {
      error.textContent = 'Use a stronger password with at least 6 characters.';
      return;
    }
    if (newPassword !== confirmPassword) {
      error.textContent = 'The new passwords do not match.';
      return;
    }

    const submit = document.getElementById('password-submit');
    submit.disabled = true;
    try {
      const credential = firebase.auth.EmailAuthProvider.credential(lifeIsShortUser.email, currentPassword);
      await lifeIsShortUser.reauthenticateWithCredential(credential);
      await lifeIsShortUser.updatePassword(newPassword);
      form.reset();
      dialog.close();
      showPasswordReminder();
    } catch (passwordError) {
      error.textContent = passwordError.code === 'auth/wrong-password'
        ? 'The current password is incorrect.'
        : readableAuthError(passwordError);
    } finally {
      submit.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------
 * Auth page: liquid-pixel infinity (left) + Sign in / Sign up / Guest panel (right).
 * Built here so every page that loads auth.js gets the same page; it replaces
 * the old #auth-overlay markup and keeps the same element ids.
 * ------------------------------------------------------------------ */
const AUTH_ART_PAL = [[236,255,214],[236,255,213],[227,252,192],[204,246,134],[190,242,100],[163,228,97],[131,204,23],[125,200,29],[112,201,45],[93,198,58],[101,191,45],[65,192,85],[38,188,110],[21,185,125],[16,185,129],[111,177,26],[90,178,46],[92,162,32],[91,152,25],[41,176,97],[18,176,120],[35,158,89],[81,138,25],[76,125,19],[73,115,14],[71,112,14],[34,138,74],[33,119,59],[63,110,21],[47,108,36],[20,105,61],[10,102,70],[9,102,71],[0,0,0]];
const AUTH_ART_ROWS = ["..................sssssssssss...........................................00002344444..................",".................sssssssssssss.........................................0000023444444.................",".................nnnnnnnnnnnnnm.......................................00000023444444.................","................fhiiiiiiiiiiihha.....................................0000000234444444................","...........pnif77ffffffffffffaaaahmss...........................00000000000023444444444444...........","..........oonif77777788888888888ahmss...........................000000000000234444444444444..........","..........mmiff77777778888888888aghmmn.........................0000000000000234444444455559..........","........pnihff777777777788888888aaghhmss.....................000000000000000234444444455bbjqv........",".......ppmif777777777777888888888aaahmss.....................00000000000000023444444445bcclqvv.......",".......mmif777777fff777788aagaa8888aghmnn...................000000000000000023444444555bcklqww.......",".......iiff77777ffihff....ghihga888aaghims.................0000000000000000....444455bbcckklll.......",".......ff7777777fimnm......mnmha888aaaagmnt...............0000000000000000......4445bcccddkkkk.......",".......77666777ffmos.......ssnha8aaaaaaghmtt.............22211000000000000.......445bkkkdddddk.......","......hf76667ffhimo.........snhaagghggaaghmmn...........33322100000000000.........5bjlkkdddddkl......","....poif76667fimmn...............hmmhg99gggmmtt.......44433322000000...............bqqlkkddddkqwv....","....ooif76777hmpp.................ttmg99999gmtt.......4444433211100.................vvwlkddddkqwv....","....iiff77fffimp...................tmg99999ghmmt.....4444444332221...................vwllkkkdklqq....","....fff767fiimn.....................hg99999gggmmtma54444444433332.....................wqqlkkdkkkl....","....77766fimoo.......................999999999gmtma5444444444444.......................wwwlkeddkk....","....66666finpp........................99999999ghmh8544444444444........................vvwlkeeeee....","....66666finpp.........................9999999gggg854444444444.........................vvwlkeeeee....","....66666finpp..........................99999999g955444444444..........................vvwlkeeeee....","...766666finpp..........................999999999955444444444..........................vvwlkeeeeek...","...f766667fmp...........................gggg99999995555444444...........................vwlkeeeekk...",".pnif66667f.............................ttmgg9999999955444444.............................kkeeeeklww.","ppnif66666..............................tttmg9999bbbb95444444..............................eeeeeklwww","ppnif66666...............................ttmggg9bbbbb9955544...............................eeeeeklwww","ppnif66666.................................tmmggbbbbbbgga8.................................eeeeeklwww","ppnif66666..................................ttqgbbbbbbqtt..................................eeeeeklwww","ppnif66666..................................ttrgbbbbblrtt..................................eeeeeklwww","ppnif66666..................................ttrgbbbbblrtt..................................eeeeeklwww","ppnif66666..................................ttrgbbbbblrtt..................................eeeeeklwww","ppnif66666..................................ttqgbbbbblqtt..................................eeeeeklwww","ppnif66666.................................tmmggbbbbbbqqrr.................................eeeeeklwww","ppnif66666...............................ttmggg9bbbbbbbbqqtt...............................eeeeeklwww","ppnif66666..............................tttmg9999bbbbbbbbqttt..............................eeeeeklwww",".pnif66667f.............................ttmgg9999bbbbbbbbqqrr.............................kkeeeeklww.","...f766667fmp...........................gggg999999bbbbbbbblll...........................vwlkeeeekk...","...766666finpp..........................9999999999bbbbbbbbbjj..........................vvwlkeeeeek...","....66666finpp..........................99999999ggbbbbbbbbbbb..........................vvwlkeeeee....","....66666finpp.........................9999999ggghqqqlbbbbbbbb.........................vvwlkeeeee....","....66666finpp........................99999999ghmtrrqqjbbbbbbbb........................vvwlkeeeee....","....77766fimoo.......................999999999gmtttrrqljjbbbbbbj.......................wwwlkeddkk....","....fff767fiimn.....................hg99999gggmmtttrrqqlljjbbbbjl.....................wqqlkkdkkkl....","....iiff77fffimp...................tmg99999ghmmt.....rqqqljbbbjlqu...................vwllkkkdklqq....","....ooif76777hmpp.................ttmg99999gmtt.......uuqljbbbjlquu.................vvwlkddddkqwv....","....poif76667fimmn...............hmmhg99gggmmtt.......uurqljjjjlqqqq...............wwqlkkddddkqwv....","......hf76667ffhimo.........snhaagghggaaghmmn...........rqqqljbjllljcjlru.........vqqlkkdddddkl......",".......77666777ffmos.......ssnha8aaaaaaghmtt.............rrqljbjjjjjcjlruu.......vvqlkkkdddddk.......",".......ff7777777fimnm......mnmha888aaaagmnt...............urqljjjjcccjlqrr......qwwlkdddddkkkk.......",".......iiff77777ffihff....ghihga888aaghims.................rqqlljcccccjlqll....kllllkddddkklll.......",".......mmif777777fff777788aagaa8888aghmnn...................rrqljcccccjjjjccccddkkkkkddddklqww.......",".......ppmif777777777777888888888aaahmss.....................urqlcccccccccccccddddddddddkklwvv.......","........pnihff777777777788888888aaghhmss.....................urqqlljccccccccccddddddddkkllqwv........","..........mmiff77777778888888888aghmmn.........................rqqllccccccccccddddddddklqqq..........","..........oonif77777788888888888ahmss...........................uuqljcccccccccddddddddkqvvv..........","...........pnif77ffffffffffffaaaahmss...........................uuqljcjjllllllkkkkkkkdkqvv...........","................fhiiiiiiiiiiihha.....................................jllqqqqqqqqqqqll................",".................nnnnnnnnnnnnnm.......................................qvvvvvvvvvvvvv.................",".................sssssssssssss.........................................vvvvvvvvvvvvv.................","..................sssssssssss...........................................vvvvvvvvvvv.................."];
const AUTH_SCRIPT_SRC = document.currentScript ? document.currentScript.src : '';
function authLogoUrl() {
  try { return AUTH_SCRIPT_SRC ? new URL('../../deserve.png', AUTH_SCRIPT_SRC).href : ''; } catch (e) { return ''; }
}
const AUTH_BG_PALETTE = [[10,28,22],[14,38,30],[18,48,36],[12,32,26],[22,58,44],[8,22,18],[26,66,50],[16,42,32]];

const AuthPixels = (() => {
  const ART_W = AUTH_ART_ROWS[0].length, ART_H = AUTH_ART_ROWS.length;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mouse = { x: -9999, y: -9999, vx: 0, vy: 0, radius: 120 };
  let canvas, ctx, host, raf = 0, running = false;
  let width = 0, height = 0, pixelSize = 10, gap = 1, particles = [];

  function resize() {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    width = Math.floor(rect.width);
    height = Math.floor(rect.height);
    if (!width || !height) { particles = []; return; }
    canvas.width = width;
    canvas.height = height;
    // one grid cell = one art pixel, so background and infinity pixels are the same size
    const pitch = Math.max(3, Math.floor(Math.min(width * 0.85 / ART_W, height * 0.85 / ART_H)));
    gap = Math.max(1, Math.round(pitch * 0.08));
    pixelSize = pitch - gap;
    mouse.radius = Math.max(90, pitch * 14);
    const cols = Math.ceil(width / pitch), rows = Math.ceil(height / pitch);
    const offX = Math.round((cols - ART_W) / 2), offY = Math.round((rows - ART_H) / 2);
    particles = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const ox = x * pitch + pixelSize / 2, oy = y * pitch + pixelSize / 2;
        const u = x - offX, v = y - offY;
        const ch = (u >= 0 && u < ART_W && v >= 0 && v < ART_H) ? AUTH_ART_ROWS[v][u] : '.';
        let color;
        if (ch !== '.') {
          color = AUTH_ART_PAL[parseInt(ch, 36)];
        } else {
          const c = AUTH_BG_PALETTE[Math.floor(Math.random() * AUTH_BG_PALETTE.length)];
          const b = 0.85 + Math.random() * 0.3;
          color = [Math.min(255, Math.floor(c[0] * b)), Math.min(255, Math.floor(c[1] * b)), Math.min(255, Math.floor(c[2] * b))];
        }
        particles.push({ ox, oy, x: ox, y: oy, vx: 0, vy: 0, color, size: pixelSize * (ch !== '.' ? 1 : 0.9 + Math.random() * 0.2) });
      }
    }
    draw();
  }

  function update() {
    const maxDisp = Math.max(4, (pixelSize + gap) * 0.8);
    mouse.vx *= 0.9; mouse.vy *= 0.9;
    for (const p of particles) {
      p.vx += (p.ox - p.x) * 0.1;
      p.vy += (p.oy - p.y) * 0.1;
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < mouse.radius) {
        const f = Math.pow(1 - dist / mouse.radius, 2);
        p.vx += mouse.vx * f * 0.35;
        p.vy += mouse.vy * f * 0.35;
        if (dist > 0.1) { p.vx += (dx / dist) * f * 1.2; p.vy += (dy / dist) * f * 1.2; }
      }
      p.vx *= 0.8; p.vy *= 0.8;
      p.x += p.vx; p.y += p.vy;
      const hx = p.x - p.ox, hy = p.y - p.oy, d = Math.sqrt(hx * hx + hy * hy);
      if (d > maxDisp) { p.x = p.ox + (hx / d) * maxDisp; p.y = p.oy + (hy / d) * maxDisp; }
    }
  }

  function draw() {
    if (!ctx || !width) return;
    ctx.fillStyle = '#07110d';
    ctx.fillRect(0, 0, width, height);
    for (const p of particles) {
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const s = p.size * (1 + Math.min(speed * 0.015, 0.25));
      ctx.fillStyle = 'rgb(' + p.color[0] + ',' + p.color[1] + ',' + p.color[2] + ')';
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
  }

  function loop() {
    if (!running) return;
    update();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function setMouse(x, y) {
    const rect = canvas.getBoundingClientRect();
    const nx = x - rect.left, ny = y - rect.top;
    if (mouse.x > -999) {
      mouse.vx = mouse.vx * 0.6 + (nx - mouse.x) * 0.4;
      mouse.vy = mouse.vy * 0.6 + (ny - mouse.y) * 0.4;
    }
    mouse.x = nx; mouse.y = ny;
  }
  function clearMouse() { mouse.x = -9999; mouse.y = -9999; }

  return {
    mount(canvasEl, hostEl) {
      canvas = canvasEl; host = hostEl; ctx = canvas.getContext('2d');
      host.addEventListener('mousemove', (e) => setMouse(e.clientX, e.clientY));
      host.addEventListener('mouseleave', clearMouse);
      host.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) setMouse(t.clientX, t.clientY); }, { passive: true });
      host.addEventListener('touchend', clearMouse);
      window.addEventListener('resize', () => { if (running) resize(); });
    },
    start() {
      if (running || !host) return;
      running = true;
      resize();
      setTimeout(() => { if (running && !particles.length) resize(); }, 120);   // layout may not be ready on the first frame
      if (!reduceMotion) raf = requestAnimationFrame(loop);
    },
    stop() { running = false; cancelAnimationFrame(raf); }
  };
})();

function hasPasswordProvider(user) {
  return Boolean(user && (user.providerData || []).some((p) => p.providerId === 'password'));
}

function ensureAuthPageStyles() {
  if (document.getElementById('auth-page-styles')) return;
  const st = document.createElement('style');
  st.id = 'auth-page-styles';
  st.textContent = `
    .auth-overlay.ap-overlay { display: grid; grid-template-columns: 1fr 1fr; align-items: stretch; justify-content: stretch; width: 100vw; height: 100vh; height: 100dvh; padding: 0; --bg: #07110d; --surface: #0b1510; --surface2: #10201a; --surface3: #17291f; --line: #1f3a2d; --line-soft: #173026; --text: #e9f3ee; --muted: #8aa89a; --faint: #587766; --lav: #3ddc97; color: var(--text); background: var(--bg); }
    .auth-overlay.ap-overlay[hidden], .ap-overlay [hidden] { display: none !important; }
    .ap-visual { position: relative; min-height: 0; overflow: hidden; background: #07110d; }
    .ap-visual canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .ap-panel { display: flex; min-height: 0; padding: 2rem; overflow-y: auto; background: var(--surface); border-left: 1px solid var(--line); }
    .ap-inner { width: 100%; max-width: 380px; margin: auto; }
    .ap-head { text-align: center; margin-bottom: 1.3rem; }
    .ap-head .auth-kicker { margin-bottom: .45rem; }
    .ap-head h1 { margin: 0 0 .35rem; font-size: 1.5rem; letter-spacing: -.02em; }
    .ap-head p { margin: 0; color: var(--muted); font-size: .9rem; }
    @media (min-width: 481px) { .ap-head p { white-space: nowrap; } }
    .ap-tabs { display: flex; gap: .35rem; margin-bottom: 1.2rem; padding: 4px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
    .ap-tab { flex: 1; padding: .5rem .4rem; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font: inherit; font-size: .85rem; font-weight: 600; cursor: pointer; transition: background .15s, color .15s; }
    .ap-tab:hover { color: var(--text); }
    .ap-tab.active { background: var(--surface3); color: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, .3); }
    .ap-view { display: grid; gap: .8rem; }
    .ap-btn { display: inline-flex; align-items: center; justify-content: center; gap: .6rem; width: 100%; min-height: 44px; padding: 0 1.1rem; border-radius: 999px; border: 1px solid var(--line); background: var(--surface2); color: var(--text); font: inherit; font-size: .925rem; font-weight: 600; cursor: pointer; transition: border-color .15s, color .15s, transform .1s, filter .15s; }
    .ap-btn:hover { border-color: var(--lav); color: var(--lav); }
    .ap-btn:active { transform: scale(.98); }
    .ap-btn:disabled { opacity: .6; cursor: default; }
    .ap-btn svg { width: 18px; height: 18px; flex-shrink: 0; }
    .ap-btn-primary { border-color: transparent; color: #06130d; background: linear-gradient(135deg, #84cc18, #10b981); box-shadow: 0 4px 20px rgba(16, 185, 129, .28); }
    .ap-btn-primary:hover { color: #06130d; filter: brightness(1.08); }
    .ap-btn-ghost { background: transparent; color: var(--muted); }
    .ap-divider { display: flex; align-items: center; gap: .75rem; color: var(--muted); font-size: .8rem; }
    .ap-divider::before, .ap-divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    .ap-field { display: grid; gap: .35rem; }
    .ap-field label { color: var(--muted); font-size: .8rem; font-weight: 600; }
    .ap-label-row { display: flex; align-items: center; justify-content: space-between; }
    .ap-link { padding: 0; border: 0; background: none; color: var(--lav); font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; }
    .ap-link:hover { text-decoration: underline; text-underline-offset: 2px; }
    .ap-input { width: 100%; height: 44px; padding: 0 1rem; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--text); font: inherit; font-size: .925rem; outline: none; transition: border-color .15s; }
    .ap-input::placeholder { color: var(--faint); }
    .ap-input:-webkit-autofill, .ap-input:-webkit-autofill:hover, .ap-input:-webkit-autofill:focus { -webkit-box-shadow: 0 0 0 1000px #07110d inset; -webkit-text-fill-color: #e9f3ee; caret-color: #e9f3ee; transition: background-color 9999s ease-in-out 0s; }
    .ap-brand { display: flex; align-items: center; justify-content: center; gap: .55rem; }
    .ap-brand-logo { width: 28px; height: 28px; border-radius: 8px; object-fit: cover; }
    .ap-input:focus { border-color: var(--lav); }
    .ap-switch { padding: .2rem 0; border: 0; background: none; color: var(--muted); font: inherit; font-size: .85rem; text-align: center; cursor: pointer; }
    .ap-switch span { color: var(--lav); font-weight: 700; }
    .ap-note { padding: 1rem 1.1rem; border: 1px solid rgba(61, 220, 151, .28); border-radius: 14px; background: linear-gradient(100deg, var(--green-soft), var(--surface2) 75%); }
    .ap-note-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .8rem; }
    .ap-note-head i { color: var(--green); }
    .ap-note-list { display: grid; gap: .75rem; margin: 0; padding: 0; list-style: none; }
    .ap-note-list li { display: grid; grid-template-columns: 1.4rem 1fr; gap: .6rem; align-items: start; color: var(--muted); font-size: .85rem; line-height: 1.5; }
    .ap-note-list i { margin-top: .2rem; color: var(--green); text-align: center; }
    .ap-msg { min-height: 1.2rem; margin: .9rem 0 0; font-size: .85rem; text-align: center; }
    .ap-msg.auth-error { color: var(--red); }
    .ap-msg.ap-ok { color: var(--green); }
    @media (max-width: 900px) { .auth-overlay.ap-overlay { grid-template-columns: 1fr; } .ap-visual { display: none; } .ap-panel { border-left: 0; padding: 1.5rem 1.2rem; } }
  `;
  document.head.appendChild(st);
}

function buildAuthPage() {
  const old = document.getElementById('auth-overlay');
  if (!old || old.dataset.authPage) return;
  ensureAuthPageStyles();
  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.className = 'auth-overlay ap-overlay';
  overlay.dataset.authPage = '1';
  overlay.hidden = old.hidden;
  overlay.innerHTML = `
    <div class="ap-visual" id="ap-visual"><canvas id="ap-canvas" aria-hidden="true"></canvas></div>
    <div class="ap-panel">
      <section class="ap-inner" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <div class="ap-head">
          <span class="auth-kicker ap-brand"><img class="ap-brand-logo" id="ap-brand-logo" alt="" hidden><span>WELCOME TO INFINITE</span></span>
          <h1 id="auth-title">We deserve better.</h1>
          <p id="auth-description"></p>
        </div>
        <div class="ap-tabs" id="ap-tabs" role="tablist">
          <button type="button" class="ap-tab" role="tab" data-auth-tab="signin">Sign in</button>
          <button type="button" class="ap-tab" role="tab" data-auth-tab="signup">Sign up</button>
          <button type="button" class="ap-tab" role="tab" data-auth-tab="guest">Guest</button>
        </div>

        <div class="ap-view" data-view="credentials">
          <button type="button" class="ap-btn" id="auth-google">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>
            Continue with Google
          </button>
          <div class="ap-divider">or</div>
          <form id="auth-form" class="ap-view" novalidate>
            <div class="ap-field" id="auth-name-field" hidden>
              <label for="auth-name">Name</label>
              <input class="ap-input" id="auth-name" name="name" type="text" autocomplete="name" placeholder="What should we call you?">
            </div>
            <div class="ap-field">
              <label for="auth-email">Email</label>
              <input class="ap-input" id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required>
            </div>
            <div class="ap-field">
              <div class="ap-label-row">
                <label for="auth-password">Password</label>
                <button type="button" class="ap-link" id="auth-forgot">Forgot password?</button>
              </div>
              <input class="ap-input" id="auth-password" name="password" type="password" autocomplete="current-password" minlength="6" placeholder="••••••••" required>
            </div>
            <button type="submit" class="ap-btn ap-btn-primary" id="auth-submit">Sign In</button>
            <button type="button" class="ap-switch" id="auth-mode-toggle">Don't have an account? <span>Sign up</span></button>
          </form>
        </div>

        <form class="ap-view" id="auth-reset-form" data-view="reset" novalidate hidden>
          <div class="ap-field">
            <label for="auth-reset-email">Email</label>
            <input class="ap-input" id="auth-reset-email" type="email" autocomplete="email" placeholder="you@example.com" required>
          </div>
          <button type="submit" class="ap-btn ap-btn-primary" id="auth-reset-submit">Send reset link</button>
          <button type="button" class="ap-btn ap-btn-ghost" id="auth-reset-back">Back to sign in</button>
        </form>

        <form class="ap-view" id="auth-guest-form" data-view="guest" novalidate hidden>
          <div class="ap-note">
            <div class="ap-note-head"><i class="fa-solid fa-user-lock"></i><strong>Guest mode</strong></div>
            <ul class="ap-note-list">
              <li><i class="fa-solid fa-hard-drive"></i><span>Your goals, notes and calendar are saved only in this browser, on this device.</span></li>
              <li><i class="fa-solid fa-lock"></i><span>AI chat and Team features need an account. Sign in or create one to use them.</span></li>
            </ul>
          </div>
          <div class="ap-field">
            <label for="auth-guest-name">Name (optional)</label>
            <input class="ap-input" id="auth-guest-name" type="text" autocomplete="name" placeholder="What should we call you?">
          </div>
          <button type="submit" class="ap-btn ap-btn-primary" id="auth-guest-confirm-btn">Got it, continue as guest</button>
          <button type="button" class="ap-btn ap-btn-ghost" id="auth-guest-signup-btn">Sign up instead</button>
        </form>

        <p class="ap-msg auth-error" id="auth-error" role="alert"></p>
        <p class="ap-msg ap-ok" id="auth-status" role="status" aria-live="polite"></p>
      </section>
    </div>`;
  old.replaceWith(overlay);
  const brandLogo = document.getElementById('ap-brand-logo');
  const logoUrl = authLogoUrl();
  if (brandLogo && logoUrl) {
    brandLogo.onload = () => { brandLogo.hidden = false; };
    brandLogo.onerror = () => { brandLogo.hidden = true; };
    brandLogo.src = logoUrl;
  }
  AuthPixels.mount(document.getElementById('ap-canvas'), document.getElementById('ap-visual'));
  showAuthTab(defaultAuthTab());
}

function setAuthStatus(message) {
  const el = document.getElementById('auth-status');
  if (el) el.textContent = message || '';
}

// tab: 'signin' | 'signup' | 'guest' | 'reset'
function showAuthTab(tab) {
  const overlay = document.getElementById('auth-overlay');
  const form = document.getElementById('auth-form');
  if (!overlay || !form) return;
  const view = tab === 'reset' ? 'reset' : tab === 'guest' ? 'guest' : 'credentials';
  overlay.querySelectorAll('[data-auth-tab]').forEach((b) => {
    const on = b.dataset.authTab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.getElementById('ap-tabs').hidden = tab === 'reset';
  overlay.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== view; });
  setAuthError('');
  setAuthStatus('');

  const signup = tab === 'signup';
  form.dataset.mode = signup ? 'signup' : 'signin';
  document.getElementById('auth-name-field').hidden = !signup;
  document.getElementById('auth-name').required = signup;
  document.getElementById('auth-forgot').hidden = signup;
  document.getElementById('auth-submit').textContent = signup ? 'Create account' : 'Sign In';
  document.getElementById('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  document.getElementById('auth-mode-toggle').innerHTML = signup
    ? 'Already have an account? <span>Sign in</span>'
    : "Don't have an account? <span>Sign up</span>";
  document.getElementById('auth-description').textContent = {
    signin: 'Welcome back. Your progress is waiting.',
    signup: 'Create an account to sync your progress.',
    guest: 'Try Infinite without an account.',
    reset: "We'll email you a link to reset your password."
  }[tab];
  if (!firebaseConfigIsReady()) setAuthError('Add your Firebase web config in static/js/auth.js before using accounts.');

  const focusId = { signin: 'auth-email', signup: 'auth-name', guest: 'auth-guest-name', reset: 'auth-reset-email' }[tab];
  if (!overlay.hidden) document.getElementById(focusId)?.focus();
}

// Older names still used elsewhere in this file.
function showAuthForm(mode) { showAuthTab(mode === 'signup' ? 'signup' : 'signin'); }
function defaultAuthTab() {
  try { return localStorage.getItem('infinite_returning') ? 'signin' : 'signup'; } catch (e) { return 'signup'; }
}
function showAuthChoices() { showAuthTab(defaultAuthTab()); }
function showGuestConfirm() { showAuthTab('guest'); }

async function loadFirestoreData(user) {
  const snapshot = await lifeIsShortDb.collection('users').doc(user.uid).get();
  if (snapshot.exists && snapshot.data().data) {
    applyLifeIsShortData(snapshot.data().data);
  } else {
    await lifeIsShortDb.collection('users').doc(user.uid).set({
      data: getStoredLifeIsShortData(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

function startFirebase() {
  if (!firebaseConfigIsReady() || !window.firebase) return false;
  firebase.initializeApp(firebaseConfig);
  lifeIsShortAuth = firebase.auth();
  lifeIsShortDb = firebase.firestore();
  // Expose to other pages/scripts (e.g. the Team feature) that load after auth.js.
  window.lifeIsShortAuth = lifeIsShortAuth;
  window.lifeIsShortDb = lifeIsShortDb;
  lifeIsShortAuth.requireSignIn = () => { setAuthOverlayVisible(true); showAuthTab('signin'); };
  lifeIsShortAuth.getRedirectResult().catch((error) => setAuthError(readableAuthError(error)));
  lifeIsShortAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((error) => {
    console.warn('Unable to keep the account signed in', error);
  });
  lifeIsShortAuth.onAuthStateChanged(async (user) => {
    if (user) {
      lifeIsShortUser = user;
      window.lifeIsShortUser = user;
      try { localStorage.setItem('infinite_returning', '1'); } catch (e) { /* ignore */ }
      setAuthOverlayVisible(false);   // signed in: never show the auth page
      localStorage.setItem(LIFE_IS_SHORT_MODE_KEY, 'account');
      if (user.displayName) localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, user.displayName);
      updateSiteGreeting();
      applyProfileToChip();                       // show any cached picture right away
      loadProfilePhoto(user).then(applyProfileToChip);
      try {
        await loadFirestoreData(user);
        setAccountActions(user);
        setAuthOverlayVisible(false);
      } catch (error) {
        setAuthOverlayVisible(true);
        setAuthError('Unable to load your synced data. Check your Firestore rules and try again.');
      }
      document.dispatchEvent(new CustomEvent('lifeIsShortAuthState', { detail: { user } }));
      return;
    }
    lifeIsShortUser = null;
    window.lifeIsShortUser = null;
    profilePhotoLoaded = false;
    setAccountActions(null);
    applyProfileToChip();
    const hasGuestMode = localStorage.getItem(LIFE_IS_SHORT_MODE_KEY) === 'guest';
    if (!hasGuestMode) {
      localStorage.removeItem(LIFE_IS_SHORT_NAME_KEY);
      const pw = document.getElementById('auth-password');
      if (pw) pw.value = '';
      showAuthChoices();
    }
    updateSiteGreeting();
    setAuthOverlayVisible(!hasGuestMode);
    document.dispatchEvent(new CustomEvent('lifeIsShortAuthState', { detail: { user: null } }));
  });
  return true;
}

async function signInWithGoogle() {
  setAuthError('');
  setAuthStatus('');
  if (!lifeIsShortAuth) {
    setAuthError('Account sign-in is unavailable until Firebase is configured.');
    return;
  }
  const button = document.getElementById('auth-google');
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  button.disabled = true;
  try {
    await lifeIsShortAuth.signInWithPopup(provider);
  } catch (error) {
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/operation-not-supported-in-this-environment') {
      try { await lifeIsShortAuth.signInWithRedirect(provider); return; } catch (redirectError) { error = redirectError; }
    }
    if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
      setAuthError(readableAuthError(error));
    }
  } finally {
    button.disabled = false;
  }
}

async function sendPasswordReset(event) {
  event.preventDefault();
  setAuthError('');
  setAuthStatus('');
  if (!lifeIsShortAuth) {
    setAuthError('Account sign-in is unavailable until Firebase is configured.');
    return;
  }
  const email = document.getElementById('auth-reset-email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    setAuthError('Enter a valid email address.');
    return;
  }
  const submit = document.getElementById('auth-reset-submit');
  submit.disabled = true;
  try {
    await lifeIsShortAuth.sendPasswordResetEmail(email);
    setAuthStatus('Reset link sent. Check your inbox (and spam folder).');
  } catch (error) {
    setAuthError(readableAuthError(error));
  } finally {
    submit.disabled = false;
  }
}

function startGuestMode() {
  const nameInput = document.getElementById('auth-guest-name');
  const name = nameInput ? nameInput.value.trim() : '';
  if (name) localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, name);
  localStorage.setItem(LIFE_IS_SHORT_MODE_KEY, 'guest');
  setAccountActions(null);
  updateSiteGreeting();
  setAuthOverlayVisible(false);
}

function setupAuthUi() {
  setupPasswordForm();
  document.addEventListener('lifeIsShortRequireSignIn', () => {
    if (!document.getElementById('auth-overlay')) return;
    setAuthOverlayVisible(true);
    showAuthTab('signin');
  });
  document.getElementById('guest-mode-signin')?.addEventListener('click', () => {
    setAuthOverlayVisible(true);
    showAuthTab('signin');
  });
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    button.addEventListener('click', () => showAuthTab(button.dataset.authTab));
  });
  document.getElementById('auth-mode-toggle')?.addEventListener('click', () => {
    showAuthTab(document.getElementById('auth-form').dataset.mode === 'signup' ? 'signin' : 'signup');
  });
  document.getElementById('auth-forgot')?.addEventListener('click', () => {
    const typed = document.getElementById('auth-email').value.trim();
    showAuthTab('reset');
    if (typed) document.getElementById('auth-reset-email').value = typed;
  });
  document.getElementById('auth-reset-back')?.addEventListener('click', () => showAuthTab('signin'));
  document.getElementById('auth-reset-form')?.addEventListener('submit', sendPasswordReset);
  document.getElementById('auth-google')?.addEventListener('click', signInWithGoogle);
  document.getElementById('auth-guest-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    startGuestMode();
  });
  document.getElementById('auth-guest-signup-btn')?.addEventListener('click', () => showAuthTab('signup'));

  document.getElementById('auth-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setAuthError('');
    setAuthStatus('');
    if (!lifeIsShortAuth) {
      setAuthError('Account sign-in is unavailable until Firebase is configured.');
      return;
    }
    const name = document.getElementById('auth-name')?.value.trim() || '';
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const mode = event.currentTarget.dataset.mode;
    if (mode === 'signup' && !name) {
      setAuthError('Tell us what to call you.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError('Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setAuthError('Use a stronger password with at least 6 characters.');
      return;
    }
    const submit = document.getElementById('auth-submit');
    submit.disabled = true;
    try {
      if (mode === 'signup') {
        const credential = await lifeIsShortAuth.createUserWithEmailAndPassword(email, password);
        await credential.user.updateProfile({ displayName: name });
        localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, name);
        updateSiteGreeting();
        showPasswordReminder();
      } else {
        await lifeIsShortAuth.signInWithEmailAndPassword(email, password);
      }
    } catch (error) {
      setAuthError(readableAuthError(error));
    } finally {
      submit.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------
 * Profile: click the user chip (bottom of the sidebar) to change your name,
 * set a profile picture, or jump to Change password.
 * Account pictures live in Firestore at users/{uid}.profile.photo (a small
 * square JPEG), guests keep theirs in this browser only.
 * ------------------------------------------------------------------ */

const PHOTO_PREFIX = 'life_photo_';
const PHOTO_SIZE = 128;                       // px, square (small: it is also copied into your teams)
const PHOTO_MAX_INPUT_BYTES = 10 * 1024 * 1024;
let profilePendingPhoto;                      // undefined = unchanged, null = remove, string = new picture
let profilePhotoLoaded = false;               // true once the account picture has been read from Firestore

// Used by team.js so teammates can see your picture.
window.infiniteProfile = {
  getPhoto: () => (lifeIsShortUser ? currentProfilePhoto() : ''),
  isReady: () => profilePhotoLoaded
};

function photoStorageKey() {
  return PHOTO_PREFIX + (lifeIsShortUser ? lifeIsShortUser.uid : 'guest');
}

function currentProfilePhoto() {
  try { return localStorage.getItem(photoStorageKey()) || ''; } catch (e) { return ''; }
}

function currentProfileName() {
  return (lifeIsShortUser?.displayName || localStorage.getItem(LIFE_IS_SHORT_NAME_KEY) || '').trim();
}

function initialsOf(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function paintAvatar(el, photo, name) {
  if (!el) return;
  if (photo) {
    el.style.backgroundImage = 'url("' + photo + '")';
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.color = 'transparent';
    el.textContent = initialsOf(name);
  } else {
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    el.style.color = '';
    el.textContent = initialsOf(name);
  }
}

// Sidebar chip: name + picture (pages only set the initials text, so the background image survives).
function applyProfileToChip() {
  const name = currentProfileName() || lifeIsShortUser?.email || 'Guest';
  const nameEl = document.getElementById('user-name');
  if (nameEl) nameEl.textContent = name;
  paintAvatar(document.getElementById('user-initial'), currentProfilePhoto(), name);
}

async function loadProfilePhoto(user) {
  profilePhotoLoaded = false;
  try {
    const snap = await lifeIsShortDb.collection('users').doc(user.uid).get();
    const photo = snap.exists && snap.data().profile && snap.data().profile.photo;
    if (photo) localStorage.setItem(PHOTO_PREFIX + user.uid, photo);
    else localStorage.removeItem(PHOTO_PREFIX + user.uid);
    profilePhotoLoaded = true;
  } catch (error) {
    console.warn('Unable to load profile picture', error);
  }
  document.dispatchEvent(new CustomEvent('lifeIsShortProfileReady'));
}

// ---- Photo adjuster (drag + zoom inside a circle, like WhatsApp / Instagram) ----
const CROP_STAGE = 260;                       // px, the square drag area
const CROP_CIRCLE = 220;                      // px, the circle that becomes the picture
const CROP_MAX_ZOOM = 4;                      // x the minimum (fit) zoom
let cropState = null;                         // { img, url, w, h, min, scale, x, y }

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Please choose an image file.')); return; }
    if (file.size > PHOTO_MAX_INPUT_BYTES) { reject(new Error('That image is too large. Choose one under 10 MB.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); return; }
      resolve({ img, url, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

function discardCropSource() {
  if (cropState && cropState.url) URL.revokeObjectURL(cropState.url);
  cropState = null;
}

// Keep the picture covering the whole circle (no empty gaps).
function cropClamp(c) {
  const off = (CROP_STAGE - CROP_CIRCLE) / 2;
  const dw = c.w * c.scale;
  const dh = c.h * c.scale;
  c.x = Math.min(off, Math.max(off + CROP_CIRCLE - dw, c.x));
  c.y = Math.min(off, Math.max(off + CROP_CIRCLE - dh, c.y));
}

function cropPlace(c, imgEl, zoomEl) {
  cropClamp(c);
  imgEl.style.width = (c.w * c.scale) + 'px';
  imgEl.style.height = (c.h * c.scale) + 'px';
  imgEl.style.left = c.x + 'px';
  imgEl.style.top = c.y + 'px';
  if (zoomEl) zoomEl.value = String(Math.round(((c.scale / c.min) - 1) / (CROP_MAX_ZOOM - 1) * 100));
}

// Zoom around the middle of the circle so the part you're looking at stays put.
function cropSetScale(c, scale, imgEl, zoomEl) {
  scale = Math.min(c.min * CROP_MAX_ZOOM, Math.max(c.min, scale));
  const mid = CROP_STAGE / 2;
  const px = (mid - c.x) / c.scale;
  const py = (mid - c.y) / c.scale;
  c.scale = scale;
  c.x = mid - px * scale;
  c.y = mid - py * scale;
  cropPlace(c, imgEl, zoomEl);
}

function cropReset(c) {
  c.min = CROP_CIRCLE / Math.min(c.w, c.h);   // smallest zoom that fills the circle
  c.scale = c.min;
  c.x = (CROP_STAGE - c.w * c.scale) / 2;
  c.y = (CROP_STAGE - c.h * c.scale) / 2;
}

// Cut out exactly what is inside the circle and shrink it, so it stays tiny enough to store in Firestore.
function cropExport(c) {
  const off = (CROP_STAGE - CROP_CIRCLE) / 2;
  const sx = (off - c.x) / c.scale;
  const sy = (off - c.y) / c.scale;
  const side = CROP_CIRCLE / c.scale;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c.img, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  return canvas.toDataURL('image/jpeg', 0.82);
}

// Keep teammates' view in step: your name and picture inside each team, plus the owner name on your goals.
// changes: { name?: string, photo?: string|null }   (photo null = removed)
async function syncProfileToTeams(user, changes) {
  const teams = await lifeIsShortDb.collection('teams').where('memberIds', 'array-contains', user.uid).get();
  for (const teamDoc of teams.docs) {
    const update = {};
    if (changes.name) update['members.' + user.uid + '.name'] = changes.name;
    if (changes.photo !== undefined) {
      update['members.' + user.uid + '.photo'] = changes.photo || firebase.firestore.FieldValue.delete();
    }
    if (Object.keys(update).length) await teamDoc.ref.update(update);
    if (!changes.name) continue;
    const goals = await teamDoc.ref.collection('goals').where('ownerId', '==', user.uid).get();
    if (goals.empty) continue;
    const batch = lifeIsShortDb.batch();
    goals.docs.forEach((g) => batch.update(g.ref, { ownerName: changes.name }));
    await batch.commit();
  }
}

function ensureProfileStyles() {
  if (document.getElementById('profile-styles')) return;
  const st = document.createElement('style');
  st.id = 'profile-styles';
  st.textContent = `
    .user-chip.profile-clickable { cursor: pointer; transition: border-color .15s, background .15s; }
    .user-chip.profile-clickable:hover, .user-chip.profile-clickable:focus-visible { border-color: var(--lav); outline: none; }
    .profile-dialog h2 { margin: 0; font-size: 1.15rem; }
    .profile-photo-row { display: flex; align-items: center; gap: 16px; margin-top: .3rem; }
    .profile-avatar { width: 84px; height: 84px; flex: 0 0 84px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--lav), #5b5bd6); border: 2px solid var(--line); }
    .profile-photo-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .profile-photo-actions .auth-inline-button { min-height: 2.2rem; font-size: .8rem; }
    .profile-photo-actions input[hidden] { display: none !important; }
    .profile-hint { margin: 0; font-size: .75rem; color: var(--faint); }
    .profile-email { font-size: .8rem; color: var(--muted); margin-top: -.2rem; word-break: break-all; }
    .profile-section { display: grid; gap: .5rem; padding-top: .8rem; border-top: 1px solid var(--line-soft); }
    .profile-section-title { font-size: .82rem; font-weight: 700; }
    .profile-section[hidden], .profile-email[hidden], .profile-note[hidden] { display: none !important; }
    .profile-crop { display: grid; gap: .7rem; justify-items: center; text-align: center; }
    .profile-crop[hidden] { display: none !important; }
    .profile-crop h2 { margin: 0; font-size: 1.15rem; }
    .profile-crop-stage { position: relative; width: ${CROP_STAGE}px; height: ${CROP_STAGE}px; overflow: hidden; border-radius: 14px; background: #000; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
    .profile-crop-stage:focus-visible { box-shadow: 0 0 0 2px var(--lav); }
    .profile-crop-stage:active { cursor: grabbing; }
    .profile-crop-stage img { position: absolute; max-width: none; max-height: none; pointer-events: none; user-select: none; -webkit-user-drag: none; }
    .profile-crop-ring { position: absolute; left: ${(CROP_STAGE - CROP_CIRCLE) / 2}px; top: ${(CROP_STAGE - CROP_CIRCLE) / 2}px; width: ${CROP_CIRCLE}px; height: ${CROP_CIRCLE}px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .9); box-shadow: 0 0 0 400px rgba(8, 12, 20, .62); pointer-events: none; }
    .profile-zoom { display: flex; align-items: center; gap: 10px; width: ${CROP_STAGE}px; color: var(--muted); font-weight: 700; }
    .profile-zoom input[type=range] { flex: 1; width: auto; padding: 0; border: 0; background: transparent; accent-color: var(--lav); cursor: pointer; }
    .profile-crop .auth-button, .profile-crop .auth-back-button { width: 100%; }
    .profile-note { margin: 0; padding: .6rem .75rem; border-radius: 9px; background: var(--surface2); color: var(--muted); font-size: .8rem; }
  `;
  document.head.appendChild(st);
}

function buildProfileDialog() {
  let dialog = document.getElementById('profile-dialog');
  if (dialog) return dialog;
  ensureProfileStyles();
  dialog = document.createElement('dialog');
  dialog.id = 'profile-dialog';
  dialog.className = 'auth-password-dialog profile-dialog';
  dialog.innerHTML = `
    <form class="auth-form" id="profile-form" novalidate>
      <h2>Your profile</h2>
      <div class="profile-photo-row">
        <div class="profile-avatar" id="profile-avatar" aria-label="Profile picture"></div>
        <div>
          <div class="profile-photo-actions">
            <button type="button" class="auth-inline-button" id="profile-photo-btn">Upload photo</button>
            <button type="button" class="auth-inline-button" id="profile-photo-adjust" hidden>Adjust</button>
            <button type="button" class="auth-inline-button" id="profile-photo-remove">Remove</button>
            <input type="file" id="profile-photo-input" accept="image/*" hidden>
          </div>
          <p class="profile-hint">Drag and zoom to fit the part you want in the circle.</p>
        </div>
      </div>
      <label for="profile-name">Name</label>
      <input id="profile-name" type="text" maxlength="40" autocomplete="name" placeholder="What should we call you?">
      <div class="profile-email" id="profile-email" hidden></div>
      <p class="profile-note" id="profile-guest-note" hidden>You're using Infinite as a guest, so your name and picture are saved only in this browser. Sign up to keep them on every device.</p>
      <div class="profile-section" id="profile-password-section">
        <div class="profile-section-title">Password</div>
        <button type="button" class="auth-inline-button" id="profile-password-btn">Change password</button>
      </div>
      <p class="auth-error" id="profile-error" role="alert"></p>
      <button type="submit" class="auth-button auth-button-primary" id="profile-save">Save changes</button>
      <button type="button" class="auth-back-button" id="profile-cancel">Cancel</button>
    </form>
    <div class="profile-crop" id="profile-crop" hidden>
      <h2>Adjust photo</h2>
      <p class="profile-hint">Drag to move. Zoom to fit the part you want inside the circle.</p>
      <div class="profile-crop-stage" id="profile-crop-stage" tabindex="0" aria-label="Drag to position your photo. Arrow keys move it, plus and minus zoom.">
        <img id="profile-crop-img" alt="" draggable="false">
        <div class="profile-crop-ring"></div>
      </div>
      <div class="profile-zoom"><span aria-hidden="true">&minus;</span><input type="range" id="profile-crop-zoom" min="0" max="100" value="0" aria-label="Zoom"><span aria-hidden="true">+</span></div>
      <p class="auth-error" id="profile-crop-error" role="alert"></p>
      <button type="button" class="auth-button auth-button-primary" id="profile-crop-apply">Use this photo</button>
      <button type="button" class="auth-back-button" id="profile-crop-cancel">Back</button>
    </div>`;
  document.body.appendChild(dialog);

  const q = (id) => document.getElementById(id);
  const refreshPreview = () => {
    const photo = profilePendingPhoto === undefined ? currentProfilePhoto() : (profilePendingPhoto || '');
    paintAvatar(q('profile-avatar'), photo, q('profile-name').value.trim() || currentProfileName() || '?');
    q('profile-photo-remove').hidden = !photo;
    q('profile-photo-adjust').hidden = !(cropState && typeof profilePendingPhoto === 'string');
  };

  const showForm = () => { q('profile-crop').hidden = true; q('profile-form').hidden = false; };
  const showCrop = () => {
    const c = cropState;
    if (!c) return;
    const imgEl = q('profile-crop-img');
    if (imgEl.getAttribute('src') !== c.url) imgEl.src = c.url;
    q('profile-crop-error').textContent = '';
    q('profile-form').hidden = true;
    q('profile-crop').hidden = false;
    cropPlace(c, imgEl, q('profile-crop-zoom'));
    q('profile-crop-stage').focus();
  };
  dialog._showForm = showForm;

  q('profile-photo-btn').addEventListener('click', () => q('profile-photo-input').click());
  q('profile-photo-adjust').addEventListener('click', showCrop);
  q('profile-photo-input').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    q('profile-error').textContent = '';
    try {
      const loaded = await loadImageFile(file);
      discardCropSource();
      cropState = Object.assign(loaded, { min: 1, scale: 1, x: 0, y: 0 });
      cropReset(cropState);
      showCrop();
    } catch (error) {
      q('profile-error').textContent = error.message || 'Could not use that image.';
    }
  });

  // --- the drag / zoom area ---
  const stage = q('profile-crop-stage');
  const cropImg = q('profile-crop-img');
  const zoom = q('profile-crop-zoom');
  const pointers = new Map();
  let pinchDist = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!cropState || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      cropState.x += e.clientX - prev.x;
      cropState.y += e.clientY - prev.y;
      cropPlace(cropState, cropImg, zoom);
    } else if (pointers.size === 2) {                         // pinch to zoom
      const [a, b] = Array.from(pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && dist > 0) cropSetScale(cropState, cropState.scale * (dist / pinchDist), cropImg, zoom);
      pinchDist = dist;
    }
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); pinchDist = 0; };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('wheel', (e) => {
    if (!cropState) return;
    e.preventDefault();
    cropSetScale(cropState, cropState.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), cropImg, zoom);
  }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    if (!cropState) return;
    const step = 10;
    if (e.key === 'ArrowLeft') cropState.x -= step;
    else if (e.key === 'ArrowRight') cropState.x += step;
    else if (e.key === 'ArrowUp') cropState.y -= step;
    else if (e.key === 'ArrowDown') cropState.y += step;
    else if (e.key === '+' || e.key === '=') { cropSetScale(cropState, cropState.scale * 1.1, cropImg, zoom); e.preventDefault(); return; }
    else if (e.key === '-' || e.key === '_') { cropSetScale(cropState, cropState.scale / 1.1, cropImg, zoom); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    cropPlace(cropState, cropImg, zoom);
  });
  zoom.addEventListener('input', () => {
    if (!cropState) return;
    cropSetScale(cropState, cropState.min * (1 + (CROP_MAX_ZOOM - 1) * (Number(zoom.value) / 100)), cropImg, zoom);
  });
  q('profile-crop-apply').addEventListener('click', () => {
    try {
      profilePendingPhoto = cropExport(cropState);
      showForm();
      refreshPreview();
    } catch (error) {
      q('profile-crop-error').textContent = 'Could not use that image. Try another one.';
    }
  });
  q('profile-crop-cancel').addEventListener('click', showForm);
  // Esc while adjusting goes back to the form instead of closing everything.
  dialog.addEventListener('cancel', (e) => { if (!q('profile-crop').hidden) { e.preventDefault(); showForm(); } });
  dialog.addEventListener('close', () => { showForm(); discardCropSource(); pointers.clear(); });
  q('profile-photo-remove').addEventListener('click', () => { profilePendingPhoto = null; refreshPreview(); });
  q('profile-name').addEventListener('input', refreshPreview);
  q('profile-cancel').addEventListener('click', () => dialog.close());
  q('profile-password-btn').addEventListener('click', () => { dialog.close(); showPasswordForm(); });
  let pressStartedOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => { pressStartedOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => { if (e.target === dialog && pressStartedOnBackdrop) dialog.close(); });   // click on the backdrop
  dialog._refreshPreview = refreshPreview;

  q('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = q('profile-error');
    const save = q('profile-save');
    error.textContent = '';
    const name = q('profile-name').value.trim();
    if (!name) { error.textContent = 'Please enter a name.'; q('profile-name').focus(); return; }

    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const user = lifeIsShortUser;
      const nameChanged = name !== currentProfileName();
      if (user) {
        if (nameChanged) {
          await user.updateProfile({ displayName: name });
          localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, name);
        }
        if (profilePendingPhoto !== undefined) {
          const ref = lifeIsShortDb.collection('users').doc(user.uid);
          await ref.set({
            profile: { photo: profilePendingPhoto || firebase.firestore.FieldValue.delete() }
          }, { merge: true });
          if (profilePendingPhoto) localStorage.setItem(PHOTO_PREFIX + user.uid, profilePendingPhoto);
          else localStorage.removeItem(PHOTO_PREFIX + user.uid);
        }
        if (nameChanged || profilePendingPhoto !== undefined) {
          const changes = {};
          if (nameChanged) changes.name = name;
          if (profilePendingPhoto !== undefined) changes.photo = profilePendingPhoto;
          syncProfileToTeams(user, changes).catch((e) => console.warn('Could not update your profile in your teams', e));
        }
        setAccountActions(user);
      } else {
        localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, name);
        if (profilePendingPhoto !== undefined) {
          if (profilePendingPhoto) localStorage.setItem(PHOTO_PREFIX + 'guest', profilePendingPhoto);
          else localStorage.removeItem(PHOTO_PREFIX + 'guest');
        }
        setAccountActions(null);
      }
      applyProfileToChip();
      updateSiteGreeting();
      dialog.close();
    } catch (saveError) {
      error.textContent = saveError && saveError.name === 'QuotaExceededError'
        ? 'Your browser has no room left to save the picture. Try a smaller image.'
        : readableAuthError(saveError || {});
    } finally {
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  });
  return dialog;
}

function openProfileDialog() {
  const dialog = buildProfileDialog();
  const user = lifeIsShortUser;
  profilePendingPhoto = undefined;
  document.getElementById('profile-name').value = currentProfileName();
  document.getElementById('profile-error').textContent = '';
  const email = document.getElementById('profile-email');
  email.textContent = user ? user.email : '';
  email.hidden = !user;
  document.getElementById('profile-password-section').hidden = !hasPasswordProvider(user);
  document.getElementById('profile-guest-note').hidden = !!user;
  dialog._showForm();
  dialog._refreshPreview();
  if (!dialog.open) dialog.showModal();
  document.getElementById('profile-name').focus();
}

function setupProfileUi() {
  ensureProfileStyles();
  const chip = document.querySelector('.user-chip');
  if (chip && !chip.dataset.profileWired) {
    chip.dataset.profileWired = '1';
    chip.classList.add('profile-clickable');
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('title', 'Edit profile');
    chip.addEventListener('click', openProfileDialog);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfileDialog(); }
    });
  }
  applyProfileToChip();
  // Pages re-write the chip text on auth events; repaint the picture right after they do.
  document.addEventListener('lifeIsShortAuthState', () => setTimeout(applyProfileToChip, 0));
  document.addEventListener('lifeIsShortDataReady', () => setTimeout(applyProfileToChip, 0));
}

function initializeLifeIsShortAuth() {
  setupLifeIsShortStorageSync();
  buildAuthPage();
  setupAuthUi();
  setupProfileUi();
  updateSiteGreeting();
  const hasGuestMode = localStorage.getItem(LIFE_IS_SHORT_MODE_KEY) === 'guest';
  if (!startFirebase()) {
    setAccountActions(null);
    setAuthOverlayVisible(!hasGuestMode);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeLifeIsShortAuth);
} else {
  initializeLifeIsShortAuth();
}
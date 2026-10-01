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
    'auth/too-many-requests': 'Too many attempts. Please wait and try again.'
  };
  return messages[error.code] || 'Something went wrong. Please try again.';
}

function showPasswordReminder() {
  alert('Please save your password somewhere else too. This site does not offer password recovery.');
}

function setAccountActions(user) {
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
    actions.appendChild(passwordButton);

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

function hideAllAuthSteps() {
  document.getElementById('auth-choice-buttons')?.setAttribute('hidden', '');
  document.getElementById('auth-form')?.setAttribute('hidden', '');
  document.getElementById('auth-guest-confirm')?.setAttribute('hidden', '');
}

function showAuthForm(mode) {
  const form = document.getElementById('auth-form');
  const submit = document.getElementById('auth-submit');
  const description = document.getElementById('auth-description');
  const toggle = document.getElementById('auth-mode-toggle');
  const nameField = document.getElementById('auth-name-field');
  const nameInput = document.getElementById('auth-name');
  if (!form) return;
  hideAllAuthSteps();
  form.hidden = false;
  if (submit) submit.textContent = mode === 'signup' ? 'Create account' : 'Sign In';
  form.dataset.mode = mode;
  if (nameField) nameField.hidden = false;
  if (nameInput) {
    nameInput.required = mode === 'signup';
    nameField?.querySelector('label')?.replaceChildren(
      document.createTextNode(mode === 'signup' ? 'Name' : 'Name (optional)')
    );
  }
  description.textContent = mode === 'signup'
    ? 'Create an account to keep your progress across devices.'
    : 'Welcome back. Your progress is waiting.';
  if (toggle) {
    toggle.innerHTML = mode === 'signup'
      ? 'Already have an account? <span>Sign in</span>'
      : "Don't have an account? <span>Sign up</span>";
  }
  setAuthError(firebaseConfigIsReady() ? '' : 'Add your Firebase web config in static/js/auth.js before using accounts.');
  (mode === 'signup' ? nameInput : document.getElementById('auth-email'))?.focus();
}

function showGuestConfirm() {
  if (!document.getElementById('auth-guest-confirm')) {
    const name = window.prompt('What should we call you? (Optional)')?.trim() || '';
    if (name) localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, name);
    localStorage.setItem(LIFE_IS_SHORT_MODE_KEY, 'guest');
    setAccountActions(null);
    updateSiteGreeting();
    setAuthOverlayVisible(false);
    return;
  }
  hideAllAuthSteps();
  document.getElementById('auth-guest-confirm').hidden = false;
  document.getElementById('auth-description').textContent = 'One more thing before you continue as a guest.';
}

function showAuthChoices() {
  hideAllAuthSteps();
  document.getElementById('auth-choice-buttons')?.removeAttribute('hidden');
  const description = document.getElementById('auth-description');
  if (description) description.textContent = 'Sign in to keep your progress with you, or continue locally as a guest.';
  setAuthError('');
}

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
  lifeIsShortAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((error) => {
    console.warn('Unable to keep the account signed in', error);
  });
  lifeIsShortAuth.onAuthStateChanged(async (user) => {
    if (user) {
      lifeIsShortUser = user;
      window.lifeIsShortUser = user;
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
      showAuthChoices();
    }
    updateSiteGreeting();
    setAuthOverlayVisible(!hasGuestMode);
    document.dispatchEvent(new CustomEvent('lifeIsShortAuthState', { detail: { user: null } }));
  });
  return true;
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
  document.querySelectorAll('[data-auth-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.authChoice === 'guest') {
        showGuestConfirm();
      } else {
        showAuthForm(button.dataset.authChoice);
      }
    });
  });

  document.getElementById('auth-back')?.addEventListener('click', showAuthChoices);
  document.getElementById('auth-guest-back')?.addEventListener('click', showAuthChoices);
  document.getElementById('auth-guest-confirm-btn')?.addEventListener('click', startGuestMode);
  document.getElementById('auth-guest-signup-btn')?.addEventListener('click', () => showAuthForm('signup'));

  document.getElementById('auth-mode-toggle')?.addEventListener('click', () => {
    const form = document.getElementById('auth-form');
    const nextMode = form.dataset.mode === 'signup' ? 'signin' : 'signup';
    showAuthForm(nextMode);
  });

  document.getElementById('auth-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setAuthError('');
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
        const credential = await lifeIsShortAuth.signInWithEmailAndPassword(email, password);
        if (name) {
          await credential.user.updateProfile({ displayName: name });
          localStorage.setItem(LIFE_IS_SHORT_NAME_KEY, name);
        }
      }
    } catch (error) {
      setAuthError(readableAuthError(error));
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
  document.getElementById('profile-password-section').hidden = !user;
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
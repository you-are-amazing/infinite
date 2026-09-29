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
  'life_highlight_color',
  'life_sticky_notes',
  'life_sticky_glow_enabled',
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
    setAccountActions(null);
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

function initializeLifeIsShortAuth() {
  setupLifeIsShortStorageSync();
  setupAuthUi();
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
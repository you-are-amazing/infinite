(() => {
  const NOTES_KEY = 'life_sticky_notes';
  const GLOW_KEY = 'life_sticky_glow_enabled';
  const DISMISSED_KEY = 'life_sticky_reminder_dismissed';
  let stickyNotes = [];

  function readNotes() {
    try {
      const saved = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      return [];
    }
  }

  function pendingNotes() {
    return stickyNotes.filter((note) => !note.done);
  }

  function escapeText(text) {
    const element = document.createElement('div');
    element.textContent = text;
    return element.innerHTML;
  }

  function glowEnabled() {
    return localStorage.getItem(GLOW_KEY) !== 'false';
  }

  function updateBell() {
    const button = document.getElementById('sticky-bell-btn');
    const badge = document.getElementById('sticky-bell-badge');
    if (!button || !badge) return;

    const pending = pendingNotes();
    badge.hidden = pending.length === 0;
    badge.textContent = pending.length > 9 ? '9+' : String(pending.length);
    button.classList.toggle('glow', pending.length > 0 && glowEnabled());
  }

  function saveNotes() {
    localStorage.setItem(NOTES_KEY, JSON.stringify(stickyNotes));
    updateBell();
  }

  function renderNotes() {
    const list = document.getElementById('sticky-notes-list');
    if (!list) return;
    if (stickyNotes.length === 0) {
      list.innerHTML = '<p class="sticky-notes-empty">No important tasks yet. Add one when you need a reminder.</p>';
      return;
    }

    const sorted = [...stickyNotes].sort((a, b) => Number(a.done) - Number(b.done));
    list.innerHTML = sorted.map((note) => `
      <div class="sticky-note-item ${note.done ? 'completed' : ''}" data-id="${note.id}">
        <input type="checkbox" class="goal-checkbox" ${note.done ? 'checked' : ''} data-sticky-toggle="${note.id}" aria-label="Complete ${escapeText(note.text)}">
        <span class="sticky-note-text">${escapeText(note.text)}</span>
        <button type="button" class="goal-btn" data-sticky-delete="${note.id}" aria-label="Delete sticky note">×</button>
      </div>
    `).join('');
  }

  function openNotes() {
    document.getElementById('sticky-reminder-overlay')?.setAttribute('hidden', '');
    renderNotes();
    const dialog = document.getElementById('sticky-notes-dialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function addNote() {
    const input = document.getElementById('sticky-note-text');
    const text = input?.value.trim();
    if (!text) return;
    stickyNotes.push({ id: Date.now(), text, done: false, created: new Date().toISOString() });
    saveNotes();
    renderNotes();
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  function showReminderOnce() {
    const mode = localStorage.getItem('lifeIsShort_mode');
    const overlay = document.getElementById('sticky-reminder-overlay');
    const list = document.getElementById('sticky-reminder-list');
    if (!overlay || !list || !pendingNotes().length || !mode || sessionStorage.getItem(DISMISSED_KEY) === 'true') return;
    list.innerHTML = pendingNotes().slice(0, 5).map((note) => `<li>${escapeText(note.text)}</li>`).join('');
    overlay.removeAttribute('hidden');
  }

  function waitForAuthThenRemind(attempt = 0) {
    const authOverlay = document.getElementById('auth-overlay');
    if (authOverlay && !authOverlay.hidden) {
      if (attempt < 12) setTimeout(() => waitForAuthThenRemind(attempt + 1), 500);
      return;
    }
    showReminderOnce();
  }

  function bindEvents() {
    document.getElementById('sticky-bell-btn')?.addEventListener('click', openNotes);
    document.getElementById('sticky-add-btn')?.addEventListener('click', addNote);
    document.getElementById('sticky-note-text')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addNote();
      }
    });
    document.getElementById('sticky-notes-close')?.addEventListener('click', () => {
      document.getElementById('sticky-notes-dialog')?.close();
    });
    document.getElementById('sticky-notes-list')?.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-sticky-toggle]');
      const deletion = event.target.closest('[data-sticky-delete]');
      if (toggle) {
        const note = stickyNotes.find((item) => String(item.id) === toggle.dataset.stickyToggle);
        if (note) note.done = toggle.checked;
        saveNotes();
        renderNotes();
      }
      if (deletion) {
        stickyNotes = stickyNotes.filter((item) => String(item.id) !== deletion.dataset.stickyDelete);
        saveNotes();
        renderNotes();
      }
    });
    document.getElementById('sticky-reminder-open')?.addEventListener('click', openNotes);
    document.getElementById('sticky-reminder-dismiss')?.addEventListener('click', () => {
      sessionStorage.setItem(DISMISSED_KEY, 'true');
      document.getElementById('sticky-reminder-overlay')?.setAttribute('hidden', '');
    });
    document.getElementById('sticky-glow-toggle')?.addEventListener('change', (event) => {
      localStorage.setItem(GLOW_KEY, event.target.checked ? 'true' : 'false');
      updateBell();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        sessionStorage.setItem(DISMISSED_KEY, 'true');
        document.getElementById('sticky-reminder-overlay')?.setAttribute('hidden', '');
      }
    });
  }

  function initialize() {
    stickyNotes = readNotes();
    const toggle = document.getElementById('sticky-glow-toggle');
    if (toggle) toggle.checked = glowEnabled();
    renderNotes();
    updateBell();
    bindEvents();
    setTimeout(() => waitForAuthThenRemind(), 700);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();

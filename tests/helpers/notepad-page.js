/*
 * Boots the real notepad/index.html in a DOM so the tests can drive it the way a person
 * does: open the page, click a note, type into it, open a team doc.
 *
 * The page is a single inline script with no exports, so it is loaded by evaluating the
 * real file. Firebase is faked — just enough of collection/doc/query for the docs code —
 * which is enough to answer the questions that matter: is this body editable, and does
 * typing in it actually reach storage?
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function ts(ms) { return { toMillis: () => ms, seconds: Math.floor(ms / 1000), nanoseconds: 0 }; }

function fakeDb(docsByTeam) {
  // Every write the page makes is recorded here so a test can assert "nothing was saved".
  const calls = [];
  const makeDoc = (id, data) => ({ id, data: () => data, exists: true, ref: {} });

  function doc(teamId) {
    const ref = {
      id: teamId,
      collection: (name) => collection(teamId, name),
      update: (payload) => { calls.push({ op: 'update', teamId, collection: 'teams', payload }); return Promise.resolve(); },
      set: () => Promise.resolve(),
      delete: () => Promise.resolve()
    };
    return { id: teamId, data: () => ({ name: 'Team', ownerId: 'alice', inviteCode: 'ABC123', memberIds: ['alice', 'bob'], members: {} }), ref };
  }

  function collection(teamId, name) {
    return {
      where() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      onSnapshot(cb) {
        if (name === 'teams') {
          // The signed-in user's own team list.
          const snap = { docs: [doc(teamId)], forEach: (f) => f(doc(teamId)) };
          cb(snap);
        } else if (name === 'docs') {
          const list = (docsByTeam[teamId] || []).map((d) => makeDoc(d.id, d));
          cb({ docs: list, forEach: (f) => list.forEach(f), empty: list.length === 0 });
        }
        return () => {};
      },
      doc: (id) => ({ id, data: () => ({}), set: () => Promise.resolve(), update: () => Promise.resolve(), delete: () => Promise.resolve() }),
      add: () => Promise.resolve(),
      get: () => Promise.resolve({ empty: true, docs: [] })
    };
  }

  return {
    calls,
    collection: (name) => collection('t1', name),
    doc: (id) => doc(id)
  };
}

/**
 * @param {object} opts
 *   notes  - what starts in localStorage under `life_notes`
 *   user   - { uid, displayName, email } or null for a guest
 *   teamDocs - teamId -> [docData] returned to the page
 */
function openNotepad(opts) {
  const opts2 = opts || {};
  const notes = opts2.notes || [];
  const user = opts2.user || null;
  const teamDocs = opts2.teamDocs || {};

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'notepad/index.html'), 'utf8'), {
    url: 'https://example.test/notepad/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  // Seed localStorage before the page script reads it.
  window.localStorage.setItem('life_notes', JSON.stringify(notes));
  window.localStorage.setItem('life_user_name', (user && user.displayName) || 'Guest');
  window.localStorage.setItem('life_is_short_mode', user ? 'account' : 'guest');

  // Minimal stand-ins for the globals auth.js would normally have set by now.
  window.lifeIsShortUser = user;
  const db = fakeDb(teamDocs);
  window.lifeIsShortDb = db;
  window.firebase = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ts(Date.now()),
        arrayUnion: (...v) => v,
        arrayRemove: () => [],
        delete: Symbol('delete')
      }
    }
  };
  window.confirm = () => true;
  window.alert = () => {};

  // doc-attrib.js is a plain script the page loads before its own inline code.
  window.eval(fs.readFileSync(path.join(ROOT, 'static/js/doc-attrib.js'), 'utf8'));

  const inline = [...fs.readFileSync(path.join(ROOT, 'notepad/index.html'), 'utf8')
    .matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((m) => m[1].includes('InfiniteDocs'))[0][1];
  // Evaluated inside the window, exactly as the browser would run it, so the page's own
  // globals (window.lifeIsShortUser, firebase, …) are the stubs set above.
  window.eval(inline);

  const $ = (id) => window.document.getElementById(id);
  return {
    window,
    document: window.document,
    db,
    body: $('note-body'),
    title: $('note-title'),
    storedNotes: () => JSON.parse(window.localStorage.getItem('life_notes') || '[]'),
    /**
     * Types into the body the way a person does, without cheating.
     *
     * A real keystroke can only change a contentEditable element, so on a locked body the
     * DOM is left alone. The cancellable `beforeinput` is dispatched either way, which is
     * how we can see whether the page's own guard refused the edit.
     *
     * @returns {{ landed: boolean, prevented: boolean }}
     */
    type(text) {
      const el = $('note-body');
      const before = el.innerHTML;
      const ev = new window.Event('beforeinput', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'inputType', { value: 'insertText' });
      el.dispatchEvent(ev);
      const prevented = ev.defaultPrevented;
      if (el.contentEditable !== 'false' && !prevented) {
        el.innerHTML = el.innerHTML + text;
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
      }
      return { landed: el.innerHTML !== before, prevented };
    },
    openTeamDocItem(index) {
      const items = window.document.querySelectorAll('#team-doc-list .np-item .np-item-main');
      if (!items[index]) throw new Error('no team doc at index ' + index);
      items[index].dispatchEvent(new window.Event('click', { bubbles: true }));
    },
    stop() { window.close(); }
  };
}

module.exports = { openNotepad };

/*
 * Behaviour tests for the Notepad page, driven through a real DOM.
 *
 * These exist because the earlier tests only read the source, and the source was fine while
 * the page was broken: `leaveTeamMode()` returned early when no team doc was open, so the
 * body never got contentEditable="true" and personal notes could not be typed into. Every
 * test here therefore types into the page and checks where the text actually ended up.
 *
 * Run with: npm test
 */
'use strict';

const { openNotepad } = require('./helpers/notepad-page');

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
function group(name) { console.log('\n' + name); }

const ALICE = { uid: 'alice', displayName: 'Alice', email: 'alice@example.test' };
const BOB = { uid: 'bob', displayName: 'Bob', email: 'bob@example.test' };

const seedNote = [{ id: 'n1', title: 'Shopping', body: '<div>milk</div>', updatedAt: '2026-01-01T00:00:00.000Z' }];

/* ================================================================== *
 * Your own notes must be writable. This is the regression guard.
 * ================================================================== */
group('You can type in your own note');

{
  const page = openNotepad({ notes: seedNote, user: ALICE });
  check('the note body is editable on load', page.body.contentEditable === 'true',
    'contentEditable was ' + page.body.contentEditable);
  check('the note body is not marked read only for the reader',
    !page.body.classList.contains('doc-locked'));
  check('the title is not read only', page.title.readOnly === false);
  check('the editor is actually shown', page.document.getElementById('np-editor').hidden === false);

  page.type('<div>eggs</div>');
  const saved = page.storedNotes().find((n) => n.id === 'n1');
  check('typed text is saved into the note', /eggs/.test(saved.body), JSON.stringify(saved.body));
  check('the note you typed into is still the one on screen', /eggs/.test(page.body.innerHTML));
  page.stop();
}

{
  const page = openNotepad({ notes: seedNote, user: ALICE });
  page.document.getElementById('new-note').dispatchEvent(new page.window.Event('click', { bubbles: true }));
  check('a brand new note is editable too', page.body.contentEditable === 'true');
  page.type('<div>fresh</div>');
  check('a brand new note accepts text', /fresh/.test(page.storedNotes()[0].body));
  page.stop();
}

{
  const page = openNotepad({ notes: seedNote, user: null });
  check('a guest can type in their own note as well', page.body.contentEditable === 'true');
  page.type('<div>guest</div>');
  check('a guest edit is saved', /guest/.test(page.storedNotes().find((n) => n.id === 'n1').body));
  page.stop();
}

group('The formatting toolbar works on your own note');

{
  const page = openNotepad({ notes: seedNote, user: ALICE });
  const tools = page.document.querySelectorAll('.np-tools button:not(#share-team-btn)');
  check('there are formatting buttons', tools.length > 0);
  check('they are enabled on your own note', Array.from(tools).every((b) => !b.disabled));
  page.stop();
}

/* ================================================================== *
 * A "view only" team doc must not be writable, and must say so.
 * ================================================================== */
group('A view-only team doc is locked, and going back to your note works again');

const lockedDoc = {
  id: 'd1',
  title: 'Secret plan',
  ownerId: ALICE.uid,
  ownerName: 'Alice',
  permission: 'read',
  body: '<div>alice line</div>',
  updatedAt: { toMillis: () => 1000 },
  updatedBy: ALICE.uid,
  updatedByName: 'Alice'
};
const openDoc = Object.assign({}, lockedDoc, { id: 'd2', title: 'Open plan', permission: 'write' });

{
  // Bob is a member of Alice's team and did NOT share either doc.
  const page = openNotepad({ notes: seedNote, user: BOB, teamDocs: { t1: [lockedDoc, openDoc] } });

  check('the team docs list is visible once signed in',
    page.document.getElementById('team-docs-wrap').hidden === false);
  check('both team docs are listed',
    page.document.querySelectorAll('#team-doc-list .np-item').length === 2,
    String(page.document.querySelectorAll('#team-doc-list .np-item').length));

  // --- open the read-only doc
  page.openTeamDocItem(0);
  check('opening a view-only doc makes the body read only', page.body.contentEditable === 'false',
    'contentEditable was ' + page.body.contentEditable);
  check('a view-only doc is visually marked as locked', page.body.classList.contains('doc-locked'));
  check('the title of a view-only doc is read only', page.title.readOnly === true);
  check('the formatting toolbar is disabled on a view-only doc',
    Array.from(page.document.querySelectorAll('.np-tools button:not(#share-team-btn)')).every((b) => b.disabled));
  check('the access switch is hidden from a non-sender', page.document.getElementById('td-perm').hidden === true);
  check('the status line explains the lock',
    /only alice|view only|locked/i.test(page.document.getElementById('td-status').textContent),
    page.document.getElementById('td-status').textContent);

  // --- try to type in it
  const attempt = page.type('<div>bob was here</div>');
  check('a keystroke into a view-only doc is refused by the page itself', attempt.prevented === true);
  check('typing into a view-only doc changes nothing on screen', attempt.landed === false,
    page.body.innerHTML);
  check('typing into a view-only doc saves nothing to Firestore', page.db.calls.length === 0,
    JSON.stringify(page.db.calls));

  // --- back to your own note
  page.document.querySelectorAll('#note-list .np-item-main')[0]
    .dispatchEvent(new page.window.Event('click', { bubbles: true }));
  check('going back to your own note makes it editable again', page.body.contentEditable === 'true',
    'contentEditable was ' + page.body.contentEditable);
  check('and the lock styling is gone', !page.body.classList.contains('doc-locked'));
  page.type('<div>back to work</div>');
  check('and you can type in it again', /back to work/.test(page.storedNotes().find((n) => n.id === 'n1').body));
  check('and this time the page lets the keystroke through',
    page.type('<div>more</div>').landed === true);

  // --- now the doc the team may edit
  page.openTeamDocItem(1);
  check('a "can edit" team doc is editable for a teammate', page.body.contentEditable === 'true',
    'contentEditable was ' + page.body.contentEditable);
  check('but its access switch is still hidden from a non-sender',
    page.document.getElementById('td-perm').hidden === true);
  page.stop();
}

group('The person who shared a doc keeps full control of it');

{
  const page = openNotepad({ notes: seedNote, user: ALICE, teamDocs: { t1: [lockedDoc, openDoc] } });
  page.openTeamDocItem(0);
  check('the sender can still edit their own view-only doc', page.body.contentEditable === 'true',
    'contentEditable was ' + page.body.contentEditable);
  check('the sender is shown the access switch', page.document.getElementById('td-perm').hidden === false);
  check('the access switch is enabled for the sender', page.document.getElementById('td-perm').disabled === false);
  check('and it reads "view only"', page.document.getElementById('td-perm').value === 'read');
  page.stop();
}

group('A guest sees no team docs at all');

{
  const page = openNotepad({ notes: seedNote, user: null, teamDocs: { t1: [lockedDoc] } });
  check('the team docs panel is hidden', page.document.getElementById('team-docs-wrap').hidden === true);
  check('and the personal note is still editable', page.body.contentEditable === 'true');
  page.stop();
}

group('Signing out while a team doc is open lands you back in your own note');

{
  const page = openNotepad({ notes: seedNote, user: BOB, teamDocs: { t1: [lockedDoc] } });
  page.openTeamDocItem(0);
  check('a teammate is looking at the locked doc', page.body.contentEditable === 'false');
  check('the doc is on screen', /alice line/.test(page.body.innerHTML));

  // auth.js announces the sign-out on document; the page is expected to cope.
  page.window.lifeIsShortUser = null;
  page.window.lifeIsShortDb = null;
  page.document.dispatchEvent(new page.window.CustomEvent('lifeIsShortAuthState', { detail: { user: null } }));

  check('the team doc text is gone from the editor', !/alice line/.test(page.body.innerHTML),
    page.body.innerHTML);
  check('your own note is open and editable',
    page.body.contentEditable === 'true' && /milk/.test(page.body.innerHTML),
    'contentEditable ' + page.body.contentEditable + ' / ' + page.body.innerHTML);
  page.type('<div>still mine</div>');
  check('and it still saves', /still mine/.test(page.storedNotes().find((n) => n.id === 'n1').body));
  page.stop();
}

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

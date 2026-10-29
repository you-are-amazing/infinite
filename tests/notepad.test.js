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

{
  const page = openNotepad({ user: null });
  page.document.getElementById('new-note-empty')
    .dispatchEvent(new page.window.Event('click', { bubbles: true }));
  check('a guest can create a note when their list is empty', page.storedNotes().length === 1);
  check('the newly created guest note opens editable',
    page.document.getElementById('np-editor').hidden === false && page.body.contentEditable === 'true');
  page.title.value = 'Guest note';
  page.title.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  check('a guest-created note persists its title locally',
    page.storedNotes()[0] && page.storedNotes()[0].title === 'Guest note');
  page.stop();
}

group('The formatting toolbar works on your own note');

{
  const page = openNotepad({ notes: seedNote, user: ALICE });
  const tools = page.document.querySelectorAll('.np-tools button:not(#share-team-btn)');
  check('there are formatting buttons', tools.length > 0);
  check('they are enabled on your own note', Array.from(tools).every((b) => !b.disabled));
  const dlBtn = page.document.getElementById('download-note-btn');
  check('the download note button is present in the toolbar', !!dlBtn);
  check('the download note button is enabled on own note', dlBtn && !dlBtn.disabled);
  check('sidebar items have a download button', page.document.querySelectorAll('.np-item-dl').length > 0);
  page.stop();
}

group('The note PDF export keeps rich content on a white page');

async function testNotePdfExport() {
  const richNote = [{
    id: 'pdf-note',
    title: 'Formatted note',
    body: '<p><strong>Bold</strong> <em>Italic</em> <u>Underlined</u> <mark>Highlighted</mark> <span style="color: rgb(220, 38, 38)">Colored</span></p><p><a href="https://example.test">A link</a></p><p><img src="data:image/png;base64,abc" alt="Note image"></p>',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }];
  const page = openNotepad({ notes: richNote, user: ALICE });
  let exportedElement;
  let exportOptions;
  let savedName;
  const pdfCalls = [];
  const canvasProto = page.window.HTMLCanvasElement.prototype;
  canvasProto.getContext = () => ({ fillRect() {}, drawImage() {}, set fillStyle(v) {} });
  canvasProto.toDataURL = () => 'data:image/jpeg;base64,AAAA';
  page.window.html2canvas = (element, options) => {
    exportedElement = element.cloneNode(true);
    exportOptions = options;
    return Promise.resolve({ width: 1588, height: 2246 });
  };
  page.window.jspdf = { jsPDF: function () {
    this.addPage = () => pdfCalls.push('addPage');
    this.setFillColor = () => {};
    this.rect = () => {};
    this.addImage = () => pdfCalls.push('addImage');
    this.link = () => pdfCalls.push('link');
    this.setFont = () => {};
    this.setFontSize = () => {};
    this.getTextWidth = () => 10;
    this.text = () => pdfCalls.push('text');
    this.save = (name) => { savedName = name; };
  } };

  page.document.getElementById('download-note-btn')
    .dispatchEvent(new page.window.Event('click', { bubbles: true }));
  page.document.querySelector('#pdf-export-container img')
    .dispatchEvent(new page.window.Event('error'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  check('the export includes note formatting, links, and images',
    exportedElement && /<strong>Bold<\/strong>/.test(exportedElement.innerHTML) &&
      /<em>Italic<\/em>/.test(exportedElement.innerHTML) &&
      /<u>Underlined<\/u>/.test(exportedElement.innerHTML) &&
    /<mark[^>]*>Highlighted<\/mark>/.test(exportedElement.innerHTML) &&
      /color: rgb\(220, 38, 38\)/.test(exportedElement.innerHTML) &&
      /href="https:\/\/example\.test"/.test(exportedElement.innerHTML) &&
      /alt="Note image"/.test(exportedElement.innerHTML),
    exportedElement && exportedElement.querySelector('.pdf-body').innerHTML);
  check('PDF export is configured with a white background and CORS-safe images',
    exportOptions && exportOptions.backgroundColor === '#ffffff' && exportOptions.useCORS === true);
  check('the render copy is moved on-screen (this is what fixes the blank PDF)',
    exportOptions && typeof exportOptions.onclone === 'function');
  check('the export stylesheet defines white-paper styling',
    exportedElement && /background: #ffffff !important/.test(exportedElement.querySelector('style').textContent));
  check('the export is never hidden behind the page (no negative z-index)',
    exportedElement && !/z-index:\s*-/.test(exportedElement.querySelector('style').textContent));
  check('the PDF gets a page image and is saved under the note title',
    pdfCalls.includes('addImage') && savedName === 'Formatted note.pdf', String(savedName));
  page.stop();

  const fallbackPage = openNotepad({ notes: richNote, user: ALICE });
  let printedDocument;
  const iframePrototype = fallbackPage.window.HTMLIFrameElement.prototype;
  const contentWindowGetter = Object.getOwnPropertyDescriptor(iframePrototype, 'contentWindow').get;
  Object.defineProperty(iframePrototype, 'contentWindow', {
    configurable: true,
    get() {
      const frameWindow = contentWindowGetter.call(this);
      frameWindow.focus = () => {};
      frameWindow.print = () => { printedDocument = frameWindow.document; };
      return frameWindow;
    }
  });
  fallbackPage.window.setTimeout = (callback) => setTimeout(callback, 0);
  fallbackPage.window.console.error = () => {};
  fallbackPage.window.html2canvas = () => Promise.reject(new Error('Simulated PDF renderer failure'));
  fallbackPage.window.jspdf = { jsPDF: function () {} };
  fallbackPage.document.getElementById('download-note-btn')
    .dispatchEvent(new fallbackPage.window.Event('click', { bubbles: true }));
  fallbackPage.document.querySelector('#pdf-export-container img')
    .dispatchEvent(new fallbackPage.window.Event('error'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const fallbackExport = printedDocument && printedDocument.querySelector('#pdf-export-container');
  check('print fallback preserves the styled export wrapper and rich note content',
    !!fallbackExport && /<strong>Bold<\/strong>/.test(fallbackExport.innerHTML) &&
      /#pdf-export-container/.test(fallbackExport.querySelector('style').textContent) &&
      /#pdf-export-container \{ position: static !important/.test(printedDocument.head.textContent));
  fallbackPage.stop();
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
testNotePdfExport().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
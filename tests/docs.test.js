/*
 * Regression tests for the two guarantees the shared docs make:
 *
 *   1. A doc shared as "view only" cannot be written to by anybody, and it cannot be
 *      turned back into "can edit" by anybody except the person who shared it.
 *   2. When a teammate adds a line to a doc, that line carries their name.
 *
 * The client half of (1) is InfiniteDocs.acl in static/js/doc-attrib.js and the server half is
 * the /docs block in firestore.rules. Both are exercised here, together with a check that the
 * two pages really use the shared ACL instead of their own copy, and that the rules published
 * from the README and the rules deployed from firestore.rules are the same text.
 *
 * Run with: npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
function group(name) { console.log('\n' + name); }

/* ------------------------------------------------------------------ *
 * Load the real doc helpers into a DOM, exactly like a page does.
 * ------------------------------------------------------------------ */
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
const { document } = window;
new Function('window', 'document', read('static/js/doc-attrib.js'))(window, document);
const D = window.InfiniteDocs;

const ALICE = 'alice';   // shares the doc
const BOB = 'bob';       // ordinary teammate
const ROOT_USER = 'root'; // owns the team, but NOT the doc
const CAROL = 'carol';   // not a member of the team at all

const readOnly = { title: 'secret', ownerId: ALICE, ownerName: 'Alice', permission: 'read' };
const editable = { title: 'plan', ownerId: ALICE, ownerName: 'Alice', permission: 'write' };

/* ================================================================== *
 * 1. A "view only" doc stays view only.
 * ================================================================== */
group('A doc shared as view only is locked for everybody but the person who shared it');

check('the sender can still edit their own read-only doc', D.acl(readOnly, ALICE).canEdit === true);
check('an ordinary teammate CANNOT edit it', D.acl(readOnly, BOB).canEdit === false);
check('an ordinary teammate sees it as locked', D.acl(readOnly, BOB).locked === true);
check('the team owner CANNOT edit it either', D.acl(readOnly, ROOT_USER, ROOT_USER).canEdit === false);
check('a signed-out visitor CANNOT edit it', D.acl(readOnly, null).canEdit === true === false);
check('a non-member CANNOT edit it', D.acl(readOnly, CAROL).canEdit === false);

group('A "view only" doc cannot be turned into "can edit" by anybody but the sender');

check('only the sender may change the permission', D.acl(readOnly, ALICE).canChangePermission === true);
check('an ordinary teammate may NOT change it', D.acl(readOnly, BOB).canChangePermission === false);
check('the team owner may NOT change it', D.acl(readOnly, ROOT_USER, ROOT_USER).canChangePermission === false);
check('a non-member may NOT change it', D.acl(readOnly, CAROL).canChangePermission === false);
check('a signed-out visitor may NOT change it', D.acl(readOnly, null).canChangePermission === false);

group('A "can edit" doc is editable by the team, but still only the sender may lock it');

check('an ordinary teammate CAN edit it', D.acl(editable, BOB).canEdit === true);
check('the team owner CAN edit it', D.acl(editable, ROOT_USER, ROOT_USER).canEdit === true);
check('a non-member still CANNOT edit it', D.acl(editable, CAROL, null, false).canEdit === false);
check('a non-member cannot delete it either', D.acl(editable, CAROL, null, false).canDelete === false);
check('but only the sender may lock it again', D.acl(editable, BOB).canChangePermission === false);
check('and only the sender may unlock it', D.acl(editable, ALICE).canChangePermission === true);

group('The lock fails closed');

check('a doc that has not loaded cannot be edited', D.acl(null, ALICE).canEdit === false);
check('a doc with no permission field is treated as read only', D.acl({ ownerId: ALICE }, BOB).perm === 'read');
check('a doc with an unknown permission is treated as read only', D.acl({ ownerId: ALICE, permission: 'admin' }, BOB).perm === 'read');
check('a doc with no owner is editable by nobody, not even the viewer', D.acl({ permission: 'write' }, ALICE).canEdit === false);
check('delete is a separate right and is not granted by edit access', D.acl(editable, BOB, null).canDelete === false);
check('the sender can always delete their own doc', D.acl(readOnly, ALICE, null).canDelete === true);
check('the team owner can clean a doc up', D.acl(readOnly, ROOT_USER, ROOT_USER).canDelete === true);

/* ================================================================== *
 * 2. A teammate's new lines carry that teammate's name.
 * ================================================================== */
const me = (id, name) => ({ id, name });

function lines(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return Array.from(tpl.content.children).map((n) => ({
    text: (n.textContent || '').replace(/\s+/g, ' ').trim(),
    by: n.getAttribute('data-by'),
    name: n.getAttribute('data-by-name'),
    // The CSS only paints a chip when the block is NOT marked as the owner's own.
    chip: n.hasAttribute('data-by-name') && !n.hasAttribute('data-orig')
  }));
}

group('A teammate who adds content is credited by name');

const aliceEd = { id: ALICE, name: 'Alice' };
const bobEd = { id: BOB, name: 'Bob' };
const carolEd = { id: CAROL, name: 'Carol' };

// Alice shares a doc with two lines of her own.
let base = D.attribute('<div>first line</div><div>second line</div>', '', aliceEd, { id: ALICE, name: 'Alice' });
check("the sender's own lines are marked as hers, so no chip is painted",
  lines(base).every((l) => l.by === ALICE && !l.chip), JSON.stringify(lines(base)));

// Bob opens it and adds a line.
let withBob = D.attribute(base + '<div>Bob was here</div>', base, bobEd, { id: ALICE, name: 'Alice' });
let l = lines(withBob);
check("Bob's new line is stamped with his name", l[2] && l[2].by === BOB && l[2].name === 'Bob', JSON.stringify(l));
check("Bob's line is painted with a name chip", !!(l[2] && l[2].chip));
check("Alice's lines keep her name", l[0].by === ALICE && l[1].by === ALICE);
check("Bob's line gets its own colour", D.colorOf(BOB) !== D.colorOf(ALICE));

group('Names are not stolen by editing, moving or retyping');

check('re-saving without changes does not credit the saver',
  lines(D.attribute(withBob, withBob, carolEd, { id: ALICE, name: 'Alice' })).every((x) => x.by !== CAROL),
  JSON.stringify(lines(D.attribute(withBob, withBob, carolEd, { id: ALICE, name: 'Alice' }))));

const edited = D.attribute(withBob.replace('first line', 'first line EDITED'), withBob, bobEd, { id: ALICE, name: 'Alice' });
check('a line somebody actually changed is credited to whoever changed it',
  lines(edited)[0].by === BOB, JSON.stringify(lines(edited)));

const moved = D.attribute('<div>Bob was here</div>' + base, withBob, bobEd, { id: ALICE, name: 'Alice' });
check('moving a line does not change who wrote it',
  lines(moved).map((x) => x.by).join(',') === [BOB, ALICE, ALICE].join(','),
  lines(moved).map((x) => x.by).join(','));

const retyped = D.attribute(base, withBob, bobEd, { id: ALICE, name: 'Alice' });
check('deleting a line and typing it again keeps the original author',
  lines(retyped).every((x) => x.by === ALICE), JSON.stringify(lines(retyped)));

check('several people can each be credited on the same doc',
  lines(D.attribute(withBob + '<div>Carol too</div>', withBob, carolEd, { id: ALICE, name: 'Alice' }))[3].by === CAROL);

group('New lines after a soft break each get their own chip');

check('a multi-line paragraph counts as several lines',
  lines(D.attribute('<div>one<br>two<br>three</div>', '', bobEd, { id: ALICE, name: 'Alice' })).length === 3);

group('The contributor list feeds the "written with …" line');

check('both teammates are listed, the sender is not',
  JSON.stringify(D.names(withBob, ALICE)) === JSON.stringify(['Bob']),
  JSON.stringify(D.names(withBob, ALICE)));
check('the sender alone yields an empty list (they are already "By …")',
  D.names(base, ALICE).length === 0);

group('Doc content is sanitized, so a typed name cannot fake a chip');

check('scripts and handlers are stripped', !/script|onerror|onclick|<img/i.test(
  D.clean('<div onclick="x()">hi<script>alert(1)<\/script><img src=x onerror=alert(1)></div>')));
check('a name that looks like markup is reduced to plain text', (() => {
  const out = D.clean('<div data-by-name="&lt;img src=x onerror=1&gt;">hi</div>');
  const tpl = document.createElement('template');
  tpl.innerHTML = out;
  return !/[<>]/.test(tpl.content.firstChild.getAttribute('data-by-name') || '');
})());

/* ================================================================== *
 * 3. The pages really use the shared ACL (so they cannot drift apart).
 * ================================================================== */
group('Both pages ask the same shared ACL instead of keeping their own copy');

const teamJs = read('static/js/team.js');
const notepad = read('notepad/index.html');

check('team.js takes its permission decisions from InfiniteDocs.acl',
  /Docs\.acl\(/.test(teamJs) && !/ownerId === currentUser\.uid \|\| d\.permission === 'write'/.test(teamJs));
check('the Notepad takes its permission decisions from InfiniteDocs.acl',
  /Docs\.acl\(/.test(notepad) && !/ownerId === u\.uid \|\| d\.permission === 'write'/.test(notepad));
check('team.js still refuses paste and drop on a locked doc',
  /'paste', 'drop'/.test(teamJs));
check('the Notepad still refuses paste and drop on a locked doc',
  /'paste', 'drop'/.test(notepad));

/* ================================================================== *
 * 4. The doc surfaces start locked rather than start editable.
 * ================================================================== */
group('A doc surface is read only until a snapshot proves you may write');

const teamHtml = read('team/index.html');
check('the Team page docs viewer ships read only', /id="doc-body"[^>]*contenteditable="false"/.test(teamHtml));
check('the Team page chat popup ships read only', /id="doc-modal-body"[^>]*contenteditable="false"/.test(teamHtml));
check('the Notepad body ships read only', /id="note-body"[^>]*contenteditable="false"/.test(notepad));
check('no doc surface anywhere still ships contenteditable="true"',
  !/id="(doc-body|doc-modal-body|note-body)"[^>]*contenteditable="true"/.test(teamHtml + notepad));
check('team.js locks every doc surface on start up', /lockAllDocSurfaces\(\);/.test(teamJs));

group('Starting locked does not make a doc nobody can edit');

// NOTE: these are structural checks only. The real proof that a doc opens editable lives in
// tests/notepad.test.js, which loads the page in a DOM and types into it — reading the
// source proved nothing here, because the source was correct while the page was broken.
check('the chat doc card opens through the popup', /openDocModal\(msg\.sharedDocRef\.id\)/.test(teamJs));
check('a Docs tab row opens through the popup', (() => {
  const fn = teamJs.slice(teamJs.indexOf('function openDoc('), teamJs.indexOf('function closeDocViewer('));
  return /openDocModal\(id\)/.test(fn);
})());
check('the popup runs applyDocMode (the only thing that unlocks)', /applyDocMode\('doc-modal', d\)/.test(teamJs));
check('the docs tab viewer runs applyDocMode too', /applyDocMode\('doc', d\)/.test(teamJs));
check('there is exactly one place that opens the popup, and it unlocks via applyDocMode',
  (teamJs.match(/dlg\.showModal\(\)/g) || []).length === 1);
check('a personal note is handed back an editable body', /body\.contentEditable = 'true'/.test(notepad));
check('and that unlock is not skipped when no team doc is open', (() => {
  const fn = notepad.slice(notepad.indexOf('function leaveTeamMode('), notepad.indexOf('function openNote('));
  return !/if \(!teamMode\) return;/.test(fn);
})());
check('opening a personal note always leaves team mode first', /function openNote\(id\) \{\s*\n\s*leaveTeamMode\(\);/.test(notepad));
check('a team doc runs the shared ACL before deciding', /const can = canEditDoc\(d\);/.test(notepad));

/* ================================================================== *
 * 5. The deployed rules are the rules the README tells you to publish.
 * ================================================================== */
group('The /docs rules that actually enforce the lock');

const rules = read('firestore.rules');
const readme = read('README.md');
const readmeBlock = (readme.match(/```\n(rules_version[\s\S]*?)\n```/) || [])[1] || '';

// Comments are allowed to differ; the rules themselves must not.
const bare = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();

check('firestore.rules exists and declares itself', /rules_version = '2';/.test(rules));
check('the README still documents the ruleset', readmeBlock.length > 0);
check('the README block and firestore.rules are the same rules',
  bare(readmeBlock) === bare(rules),
  'README and firestore.rules have drifted apart');

check('a read-only doc cannot be written to by a teammate (permission is checked on update)',
  /resource\.data\.permission == 'write'/.test(rules));
check('a teammate may only ever touch the text, never permission/ownerId',
  /hasOnly\(\['title', 'body', 'updatedAt', 'updatedBy', 'updatedByName'\]\)/.test(rules));
check('a teammate cannot re-assign the doc to themselves',
  /resource\.data\.ownerId == request\.auth\.uid &&\s*\n\s*request\.resource\.data\.ownerId == resource\.data\.ownerId/.test(rules));
check('permission must always be one of the two known values, on create and on update',
  (rules.match(/permission in \['read', 'write'\]/g) || []).length >= 2);
check('every docs operation requires team membership', (() => {
  const docsBlock = rules.slice(rules.indexOf('match /docs/{docId}'), rules.indexOf('match /rewards/'));
  const ops = (docsBlock.match(/allow (read|create|update|delete)/g) || []).length;
  const checks = (docsBlock.match(/request\.auth\.uid in get\(/g) || []).length;
  return ops === 4 && checks === 4;
})());

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

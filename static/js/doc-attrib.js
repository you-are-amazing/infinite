/* ------------------------------------------------------------------
 * Shared doc helpers (used by static/js/team.js and notepad/index.html)
 *
 * 1. clean()      - whitelist sanitizer for anything that comes from another
 *                   teammate (docs are written by other people).
 * 2. attribute()  - figures out WHO WROTE WHICH PART of a doc. The body is
 *                   split into blocks, every block is compared with the version
 *                   that is already stored, and new / changed blocks are stamped
 *                   with data-by (uid), data-by-name (shown as a chip through
 *                   CSS) and data-c (their colour). The doc owner's own lines get
 *                   data-orig so they stay plain and only teammate additions pop.
 *                   Nothing new is added to Firestore: the stamps live inside the
 *                   already existing `body` field.
 * 3. contributors() - who has written something in this doc (for the meta line).
 * 4. acl()          - the ONE place that decides who may write to a doc, who may
 *                     delete it and who may flip read -> write. It is pure (no
 *                     Firestore, no DOM) so the rules can be unit tested, and both
 *                     the Team page and the Notepad call it instead of keeping
 *                     their own copy, which is how the two pages could drift apart
 *                     and let somebody edit a locked doc.
 *
 * Loaded as a plain <script> (no defer) so the inline page scripts can use it.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const DOC_MAX = 200000;   // characters of HTML per doc (Firestore caps a document at 1 MB)
  const DOC_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'MARK', 'BR', 'DIV', 'P', 'SPAN']);
  const BLOCK_TAGS = new Set(['DIV', 'P', 'UL', 'OL', 'BLOCKQUOTE']);

  const ATTR_BY = 'data-by';         // uid of the person who wrote this block
  const ATTR_NAME = 'data-by-name';  // their display name (rendered as a chip)
  const ATTR_COLOR = 'data-c';       // palette index 0..7, see style.css
  const ATTR_ORIG = 'data-orig';     // present when the author is the doc owner
  const KEEP_ATTRS = [ATTR_BY, ATTR_NAME, ATTR_COLOR, ATTR_ORIG];
  const PALETTE = 8;

  /* ---------- sanitizer ---------- */

  // Names only ever show up as a chip, so anything that looks like markup or a
  // control character is cut out before it is stored in data-by-name.
  function safeName(v) {
    // eslint-disable-next-line no-control-regex
    return String(v === undefined || v === null ? '' : v)
      .replace(/[\u0000-\u001f\u007f<>&"'`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  function clean(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const walk = (parent, root) => {
      Array.from(parent.childNodes).forEach((n) => {
        if (n.nodeType === 3) return;                       // plain text is always safe
        if (n.nodeType !== 1 || !DOC_TAGS.has(n.tagName)) { n.remove(); return; }
        const kept = {};
        KEEP_ATTRS.forEach((k) => { const v = n.getAttribute(k); if (v !== null) kept[k] = v; });
        Array.from(n.attributes).forEach((a) => n.removeAttribute(a.name));
        if (n.tagName === 'MARK') n.className = 'note-highlight';
        if (root) {
          if (kept[ATTR_BY]) n.setAttribute(ATTR_BY, String(kept[ATTR_BY]).replace(/[^\w-]/g, '').slice(0, 64));
          const nm = safeName(kept[ATTR_NAME]);
          if (nm) n.setAttribute(ATTR_NAME, nm);
          if (kept[ATTR_COLOR]) n.setAttribute(ATTR_COLOR, String(kept[ATTR_COLOR]).replace(/\D/g, '').slice(0, 2) || '0');
          if (kept[ATTR_ORIG] !== undefined) n.setAttribute(ATTR_ORIG, '');
        }
        walk(n, false);
      });
    };
    walk(tpl.content, true);
    return tpl.innerHTML;
  }

  /* ---------- block model ---------- */

  function stripMarkers(node) { KEEP_ATTRS.forEach((k) => node.removeAttribute(k)); }

  function copyMarkers(from, to) {
    const by = from.getAttribute(ATTR_BY);
    if (!by) return false;
    to.setAttribute(ATTR_BY, by);
    const name = safeName(from.getAttribute(ATTR_NAME));
    if (name) to.setAttribute(ATTR_NAME, name);
    const color = from.getAttribute(ATTR_COLOR);
    to.setAttribute(ATTR_COLOR, color !== null ? color : '0');
    if (from.hasAttribute(ATTR_ORIG)) to.setAttribute(ATTR_ORIG, '');
    return true;
  }

  function setMarkers(block, editor, ownerId) {
    block.setAttribute(ATTR_BY, String(editor.id).replace(/[^\w-]/g, '').slice(0, 64));
    block.setAttribute(ATTR_NAME, safeName(editor.name) || 'Someone');
    block.setAttribute(ATTR_COLOR, String(colorOf(editor.id || editor.name)));
    if (ownerId && editor.id === ownerId) block.setAttribute(ATTR_ORIG, '');
  }

  function hasContent(block) { return /\S/.test(block.textContent || ''); }

  function isBr(n) { return n.nodeType === 1 && n.tagName === 'BR'; }
  function isBlockNode(n) { return n.nodeType === 1 && BLOCK_TAGS.has(n.tagName); }

  // A hard line break inside a plain paragraph is a new block too, so typing a
  // new line under somebody else's sentence gets its own name chip.
  function splitOnBreaks(block) {
    if (block.tagName !== 'DIV' && block.tagName !== 'P') return [block];
    if (block.querySelector('div,p,ul,ol,blockquote')) return [block];
    const inner = Array.from(block.childNodes);
    if (!inner.some(isBr)) return [block];
    const groups = [];
    let current = [];
    inner.forEach((n) => {
      if (isBr(n)) { groups.push(current); current = []; }
      else current.push(n);
    });
    groups.push(current);
    return groups.map((nodes) => {
      const part = document.createElement(block.tagName);
      KEEP_ATTRS.forEach((k) => { const v = block.getAttribute(k); if (v !== null) part.setAttribute(k, v); });
      nodes.forEach((n) => part.appendChild(n));
      return part;
    });
  }

  // html -> array of top level blocks (loose text runs become <div>, a <br> ends a block)
  function blocksOf(source) {
    const out = [];
    let buffer = [];
    const flush = () => {
      if (buffer.length) {
        const box = document.createElement('div');
        buffer.forEach((n) => box.appendChild(n));
        if (hasContent(box)) out.push(box);
      }
      buffer = [];
    };
    Array.from(source.childNodes).forEach((node) => {
      if (node.nodeType === 3) { buffer.push(node); return; }
      if (node.nodeType !== 1) { node.remove(); return; }
      if (isBlockNode(node)) { flush(); out.push(node); return; }
      if (isBr(node)) { flush(); return; }
      buffer.push(node);
    });
    flush();
    const blocks = [];
    out.forEach((b) => splitOnBreaks(b).forEach((p) => blocks.push(p)));
    while (blocks.length && !hasContent(blocks[blocks.length - 1])) blocks.pop();
    return blocks;
  }

  function blocksFromHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    return blocksOf(tpl.content);
  }

  // Two blocks count as "the same line" when their text is the same, so moving or
  // reformatting a line does not steal the authorship of the person who wrote it.
  function keyOf(block) { return (block.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }


  /* ---------- public helpers ---------- */

  function colorOf(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % PALETTE;
  }

  // next = what is on screen now, base = the version already stored in Firestore.
  // Blocks that are still in base keep their old author, everything else is
  // stamped with `editor` — that is how a teammate's addition gets their name.
  function attribute(nextHtml, baseHtml, editor, owner) {
    const editorId = editor && editor.id ? String(editor.id) : '';
    const ownerId = owner && owner.id ? String(owner.id) : '';
    const tpl = document.createElement('template');
    tpl.innerHTML = clean(nextHtml);
    const pool = new Map();
    const stored = new Map();          // how often each line already appears in base
    blocksFromHtml(baseHtml).forEach((b) => {
      const k = keyOf(b);
      if (!k) return;
      stored.set(k, (stored.get(k) || 0) + 1);
      if (!b.getAttribute(ATTR_BY)) return;
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(b);
    });
    const takeStored = (k) => {
      const left = stored.get(k) || 0;
      if (!left) return false;
      stored.set(k, left - 1);
      return true;
    };
    const host = document.createElement('div');
    blocksOf(tpl.content).forEach((block) => {
      stripMarkers(block);
      if (hasContent(block)) {
        const k = keyOf(block);
        const list = pool.get(k);
        if (list && list.length && copyMarkers(list.shift(), block)) takeStored(k);
        // A line the stored copy already had but that never got a stamp (docs shared
        // before attribution existed) is not something I wrote either, so it is
        // credited to the person who shared the doc instead of to me. Extra copies of
        // a line that only existed once are mine.
        else if (takeStored(k) && ownerId) setMarkers(block, { id: ownerId, name: (owner && owner.name) || 'Someone' }, ownerId);
        else if (editorId) setMarkers(block, { id: editorId, name: (editor && editor.name) || 'Someone' }, ownerId);
      }
      host.appendChild(block);
    });
    return host.innerHTML;
  }

  // [{ id, name, color }] in order of first appearance, skipping the doc owner
  // (that person is already credited as "By ...").
  function contributors(html, ownerId) {
    const tpl = document.createElement('template');
    tpl.innerHTML = clean(html);
    const seen = new Set();
    const out = [];
    Array.from(tpl.content.children).forEach((b) => {
      const by = b.getAttribute(ATTR_BY);
      if (!by || by === ownerId || seen.has(by) || !hasContent(b)) return;
      seen.add(by);
      out.push({ id: by, name: (b.getAttribute(ATTR_NAME) || 'A teammate').trim(), color: colorOf(by) });
    });
    return out;
  }

  function names(html, ownerId) { return contributors(html, ownerId).map((c) => c.name); }

  /* ---------- access control ----------
   *
   * The rules of the game for a shared doc:
   *
   *   permission 'read'  -> the doc is LOCKED. The only person who may type is the
   *                         one who shared it, and the only person who may ever open
   *                         it up again is that same person. Not the team owner, not
   *                         anybody else in the team.
   *   permission 'write' -> every member of the team may type, autosaved as they go.
   *   anything else / missing -> treated as 'read'. A doc whose permission we do not
   *                         understand is locked, so a broken record can never be
   *                         used to open a doc up by accident.
   *
   * These functions are the client's half of the lock. The server half is the /docs
   * block in firestore.rules, which repeats every line below, so a hand-edited page
   * still cannot write to a locked doc.
   */

  function permOf(d) { return d && d.permission === 'write' ? 'write' : 'read'; }

  // Signed out, or the doc has not loaded yet: nobody may write. Everything here
  // fails closed, because "we are not sure" must never mean "you may edit".
  function uidOf(uid) { return uid ? String(uid) : ''; }

  // `isMember` is whether the person is in the team the doc lives in. The pages pass it
  // because a doc can only be read out of your own team's collection in the first place,
  // but checking it here means a doc that turns up in a team you are not in is locked
  // rather than quietly editable. Omitting it means "in the team", which is the normal case.
  function acl(d, uid, teamOwnerUid, isMember) {
    const u = uidOf(uid);
    const owner = uidOf(d && d.ownerId);
    const perm = permOf(d);
    const member = isMember === undefined ? true : !!isMember;
    if (!u || !owner || !member) return { owner: false, canEdit: false, locked: true, canChangePermission: false, canDelete: false, perm, member };
    const isOwner = u === owner;
    // 'read' locks the doc for everybody except the person who shared it.
    const canEdit = isOwner || perm === 'write';
    return {
      owner: isOwner,
      canEdit,
      locked: !canEdit,
      // Only the person who shared the doc may move the doc between read and write.
      canChangePermission: isOwner,
      // The team owner can clean a doc up, but that is a delete, never an edit.
      canDelete: isOwner || (!!teamOwnerUid && u === String(teamOwnerUid)),
      perm,
      member
    };
  }

  window.InfiniteDocs = {
    acl,
    permOf,
    DOC_MAX,
    DOC_TAGS,
    ATTR_BY,
    ATTR_NAME,
    ATTR_COLOR,
    ATTR_ORIG,
    clean,
    attribute,
    contributors,
    names,
    colorOf
  };
})();


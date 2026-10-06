/*
 * Team feature for Infinite.
 * Requires a signed-in Firebase account (not guest mode) because team data
 * is shared between multiple people. Relies on window.lifeIsShortAuth /
 * window.lifeIsShortDb being set by auth.js, and the 'lifeIsShortAuthState'
 * event auth.js dispatches whenever sign-in state changes.
 *
 * Firestore shape (see README.md for the security rules to pair with this):
 *   teams/{teamId}
 *     name, ownerId, inviteCode, memberIds: [uid...], members: { uid: { name } }, createdAt
 *   teams/{teamId}/goals/{goalId}
 *     type: 'self' | 'team', title, cadence, createdBy, createdAt
 *     -- self goals --  ownerId, ownerName, status: 'pending'|'done', reactions: { uid: emoji }
 *     -- team goals --  participants: { uid: 'pending'|'done' }
 *   teams/{teamId}/messages/{messageId}
 *     senderId, senderName, text, createdAt
 *     -- replies (WhatsApp style) --  replyTo: { id, name, text }  (snapshot, so it survives deletes)
 *     -- shared doc card --  sharedDocRef: { id, title, permission }  (points at teams/{id}/docs/{docId})
 *   teams/{teamId}/docs/{docId}
 *     title, body(html), ownerId, ownerName, permission: 'read'|'write', sourceNoteId, createdAt, updatedAt, updatedBy, updatedByName
 *   teams/{teamId}/reads/{uid}      -- read receipts: { name, at }  ("seen" = message.createdAt <= at)
 *   teams/{teamId}/typing/{uid}     -- typing indicator: { name, typing, at }  (deleted when the user stops)
 *   teams/{teamId}/rewards/{rewardId}
 *     title, createdBy, createdByName, createdAt, cheers: { uid: true }
 */

(function () {
  const REACT_EMOJI = '🔥';
  let currentUser = null;
  let currentTeamId = null;
  let teamsUnsub = null;
  let teamDocUnsub = null;
  let goalsUnsub = null;
  let lastGoalDocs = [];            // last goals snapshot, so blocks can re-render when members change
  const openGoalBlocks = new Set(); // which person/team blocks are expanded (survives live re-renders)
  let editingGoalId = null;         // goal currently being edited inline (live re-renders wait until it's saved/cancelled)
  let messagesUnsub = null;
  let rewardsUnsub = null;
  let docsUnsub = null;
  let teamDocs = [];                 // QueryDocumentSnapshots of the open team
  let openDocId = null;
  let pendingOpenDocId = null;       // a doc we just created, open it as soon as it shows up
  let docSaveTimer = null;
  let docLoadedAt = 0;               // updatedAt (ms) of the version currently in the editor
  let modalDocId = null;             // doc open in the big chat popup
  let modalSaveTimer = null;
  let modalLoadedAt = 0;
  let readsUnsub = null;
  let typingUnsub = null;
  let currentTeamData = null;
  let authMode = 'signin';

  // ---- chat state ----
  const LINK_PREVIEWS = true;     // set false to stop fetching link titles/images from microlink.io / noembed.com
  const MAX_PREVIEWS = 2;         // link cards shown per message
  const TYPING_TTL = 6000;        // ms a "typing…" flag lives without a refresh
  let readsMap = {};              // uid -> ms of last time that member had the chat open
  let typingMap = {};             // uid -> { name, at(local ms) }
  let typingFirst = true;
  let typingInterval = null;
  let iAmTyping = false;
  let typingTeamId = null;
  let lastTypingSent = 0;
  let stopTypingTimeout = null;
  let lastMsgDocs = [];
  let chatInitial = true;
  let forceScroll = false;
  let readTimer = null;
  let lastReadWriteFor = 0;
  let readRetries = 0;             // retries left for a denied/failed receipt write
  let replyTo = null;              // { id, name, text } of the message being replied to
  const msgEls = new Map();       // messageId -> element (so updates never rebuild the whole list)

  const $ = (id) => document.getElementById(id);

  function displayName() {
    return (currentUser && (currentUser.displayName || currentUser.email)) || 'Someone';
  }

  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }

  // ---- profile pictures (stored per member in the team doc: members[uid].photo) ----
  // Members can write to the team doc, so never trust the string: only accept a plain base64 image.
  const PHOTO_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/;

  function hashStr(str) {                       // tiny content hash, just to notice when a picture changed
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + str.length;
  }

  function memberPhoto(uid) {
    const m = currentTeamData && currentTeamData.members && currentTeamData.members[uid];
    const p = m && m.photo;
    return (typeof p === 'string' && p.length < 60000 && PHOTO_RE.test(p)) ? p : '';
  }

  // Picture if they set one, otherwise their initials (the default look).
  function paintMemberAvatar(el, uid, name) {
    if (!el) return;
    const photo = memberPhoto(uid);
    const key = photo ? uid + ':' + hashStr(photo) : '';
    if (el.dataset.pfKey === key && el.dataset.pfName === (name || '')) return;   // nothing changed
    el.dataset.pfKey = key;
    el.dataset.pfName = name || '';
    el.textContent = initials(name);
    if (photo) {
      el.style.backgroundImage = 'url("' + photo + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.color = 'transparent';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.color = '';
    }
  }

  // Make sure my own picture is in the team doc so teammates can see it (only ever adds/updates, never deletes).
  let photoHealKey = '';
  function ensureMyTeamPhoto() {
    if (!currentUser || !currentTeamId || !currentTeamData || !window.infiniteProfile) return;
    if (!window.infiniteProfile.isReady()) return;
    const mine = window.infiniteProfile.getPhoto();
    const me = currentTeamData.members && currentTeamData.members[currentUser.uid];
    if (!mine || !me || me.photo === mine) return;
    const key = currentTeamId + ':' + hashStr(mine);
    if (photoHealKey === key) return;                   // already tried this one
    photoHealKey = key;
    window.lifeIsShortDb.collection('teams').doc(currentTeamId)
      .update({ ['members.' + currentUser.uid + '.photo']: mine })
      .catch((e) => { console.warn('Could not share your profile picture with the team', e); });
  }

  function formatTime(ts) {
    if (!ts || !ts.toDate) return '';
    return ts.toDate().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Auth gate ----------

  function renderAuthState() {
    const signedIn = !!currentUser;
    $('no-auth-state').hidden = signedIn;
    if (!signedIn) {
      $('no-team-state').hidden = true;
      $('team-content').hidden = true;
      setChatTitle('');
      $('team-list').innerHTML = '<div class="empty-list">Sign in to see your teams.</div>';
      teardownTeamListeners();
      currentTeamId = null;
      window.infiniteActiveTeamId = null;
      clearReply();
      msgEls.clear();
      $('chat-messages').innerHTML = '<div class="chat-empty">Sign in and pick a team to start chatting.</div>';
      if (teamsUnsub) { teamsUnsub(); teamsUnsub = null; }
      return;
    }
    watchMyTeams();
  }

  function setupAuthForm() {
    $('team-auth-toggle').addEventListener('click', () => {
      authMode = authMode === 'signin' ? 'signup' : 'signin';
      $('team-auth-name-wrap').hidden = authMode !== 'signup';
      $('team-auth-submit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
      $('team-auth-toggle').textContent = authMode === 'signup'
        ? 'Already have an account? Sign in'
        : "Don't have an account? Sign up";
      $('team-auth-error').textContent = '';
    });

    $('team-auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const auth = window.lifeIsShortAuth;
      const errorEl = $('team-auth-error');
      errorEl.textContent = '';
      if (!auth) {
        errorEl.textContent = 'Sign-in is unavailable right now. Check your Firebase setup in auth.js.';
        return;
      }
      const email = $('team-auth-email').value.trim();
      const password = $('team-auth-password').value;
      const name = $('team-auth-name').value.trim();
      const submitBtn = $('team-auth-submit');
      submitBtn.disabled = true;
      try {
        if (authMode === 'signup') {
          if (!name) { errorEl.textContent = 'Tell us what to call you.'; submitBtn.disabled = false; return; }
          const credential = await auth.createUserWithEmailAndPassword(email, password);
          await credential.user.updateProfile({ displayName: name });
        } else {
          await auth.signInWithEmailAndPassword(email, password);
        }
      } catch (error) {
        errorEl.textContent = error && error.message ? error.message : 'Something went wrong. Please try again.';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------- My teams list ----------

  function watchMyTeams() {
    if (teamsUnsub) teamsUnsub();
    teamsUnsub = window.lifeIsShortDb.collection('teams')
      .where('memberIds', 'array-contains', currentUser.uid)
      .onSnapshot((snapshot) => {
        const list = $('team-list');
        if (snapshot.empty) {
          list.innerHTML = '<div class="empty-list">No teams yet. Create one or join with a code.</div>';
          // Left / lost every team — clear the open panel so it doesn't stick under "No team yet"
          clearTeamSelection();
          return;
        }
        list.innerHTML = '';
        let stillExists = false;
        snapshot.forEach((doc) => {
          const team = doc.data();
          if (doc.id === currentTeamId) stillExists = true;
          const btn = document.createElement('button');
          btn.className = 'team-item' + (doc.id === currentTeamId ? ' active' : '');
          btn.innerHTML = `<strong>${escapeHtml(team.name)}</strong><span>${(team.memberIds || []).length} member${(team.memberIds || []).length === 1 ? '' : 's'}</span>`;
          btn.addEventListener('click', () => selectTeam(doc.id));
          list.appendChild(btn);
        });
        if (!currentTeamId || !stillExists) {
          if (!currentTeamId) {
            // Coming from a notification? Open that team first.
            let want = null;
            try { want = sessionStorage.getItem('team_open_id'); sessionStorage.removeItem('team_open_id'); } catch (e) {}
            const hit = want && snapshot.docs.find((d) => d.id === want);
            selectTeam(hit ? hit.id : snapshot.docs[0].id);
          }
        }
      }, (error) => {
        console.warn('Unable to load teams', error);
        $('team-list').innerHTML = '<div class="empty-list">Could not load teams. In Firebase, open Firestore Database > Rules and publish the rules from the README.</div>';
      });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- Create / join / leave ----------

  function randomInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  async function createTeam() {
    const name = window.prompt('Name your team (e.g. "Weekend Warriors")');
    if (!name || !name.trim()) return;
    try {
      const db = window.lifeIsShortDb;
      const ref = db.collection('teams').doc();
      await ref.set({
        name: name.trim(),
        ownerId: currentUser.uid,
        inviteCode: randomInviteCode(),
        memberIds: [currentUser.uid],
        members: { [currentUser.uid]: { name: displayName() } },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      selectTeam(ref.id);
    } catch (error) {
      console.error('createTeam failed', error);
      alert('Could not create the team: ' + (error && error.message ? error.message : error) + '\n\nCheck that your Firestore rules include the teams/{teamId} block.');
    }
  }

  async function joinTeam() {
    const code = window.prompt('Enter the invite code your friend shared with you');
    if (!code || !code.trim()) return;
    try {
      const db = window.lifeIsShortDb;
      const snapshot = await db.collection('teams').where('inviteCode', '==', code.trim().toUpperCase()).limit(1).get();
      if (snapshot.empty) {
        alert('No team found with that invite code. Double-check it with your friend (it\'s case-insensitive).');
        return;
      }
      const doc = snapshot.docs[0];
      const team = doc.data();
      if ((team.memberIds || []).includes(currentUser.uid)) {
        selectTeam(doc.id);
        return;
      }
      await doc.ref.update({
        memberIds: firebase.firestore.FieldValue.arrayUnion(currentUser.uid),
        [`members.${currentUser.uid}`]: { name: displayName() }
      });
      selectTeam(doc.id);
    } catch (error) {
      console.error('joinTeam failed', error);
      alert('Could not join that team: ' + (error && error.message ? error.message : error) + '\n\nCheck that your Firestore rules include the updated teams/{teamId} block (it needs to allow a new member to add themselves).');
    }
  }

  function clearTeamSelection() {
    currentTeamId = null;
    currentTeamData = null;
    window.infiniteActiveTeamId = null;
    teardownTeamListeners();
    resetChatState();
    setChatTitle('');
    clearReply();
    updateChatTools();
    $('team-content').hidden = true;
    // Only show "No team yet" when signed in (auth gate handles signed-out)
    if (currentUser) $('no-team-state').hidden = false;
    Array.from(document.querySelectorAll('.team-item')).forEach((el) => el.classList.remove('active'));
  }

  async function leaveTeam() {
    if (!currentTeamId || !currentTeamData) return;
    if (!confirm(`Leave "${currentTeamData.name}"?`)) return;
    const leavingId = currentTeamId;
    try {
      // Clear UI first so a race with the teams list snapshot can't re-show this team.
      clearTeamSelection();
      const ref = window.lifeIsShortDb.collection('teams').doc(leavingId);
      await ref.update({
        memberIds: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
        [`members.${currentUser.uid}`]: firebase.firestore.FieldValue.delete()
      });
      // watchMyTeams will auto-select another team if any remain
    } catch (error) {
      console.error('leaveTeam failed', error);
      alert('Could not leave the team: ' + (error && error.message ? error.message : error));
    }
  }

  // Chat panel header shows the active group's name.
  function setChatTitle(name) {
    const el = document.getElementById('chat-team-name');
    const tag = document.getElementById('chat-tag');
    if (el) { el.textContent = name || 'TEAM CHAT'; el.title = name || ''; }
    if (tag) tag.textContent = name ? 'TEAM CHAT · LIVE' : 'SHARED · LIVE';
  }

  // ---------- Selecting a team ----------

  function teardownTeamListeners() {
    stopTyping();
    if (readsUnsub) { readsUnsub(); readsUnsub = null; }
    if (typingUnsub) { typingUnsub(); typingUnsub = null; }
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    clearTimeout(readTimer);
    if (teamDocUnsub) { teamDocUnsub(); teamDocUnsub = null; }
    if (goalsUnsub) { goalsUnsub(); goalsUnsub = null; }
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    if (rewardsUnsub) { rewardsUnsub(); rewardsUnsub = null; }
    if (docsUnsub) { docsUnsub(); docsUnsub = null; }
    resetDocsState();
  }

  function selectTeam(teamId) {
    if (teamId === currentTeamId) return;
    teardownTeamListeners();
    currentTeamId = teamId;
    window.infiniteActiveTeamId = teamId;
    lastGoalDocs = [];
    openGoalBlocks.clear();
    editingGoalId = null;
    resetChatState();
    $('no-team-state').hidden = true;
    $('team-content').hidden = false;

    const db = window.lifeIsShortDb;
    const teamRef = db.collection('teams').doc(teamId);

    teamDocUnsub = teamRef.onSnapshot((doc) => {
      if (!doc.exists) {
        clearTeamSelection();
        return;
      }
      currentTeamData = doc.data();
      // Kicked / left elsewhere: still on this doc but no longer a member
      const ids = currentTeamData.memberIds || [];
      if (currentUser && ids.indexOf(currentUser.uid) === -1) {
        clearTeamSelection();
        return;
      }
      renderTeamHeader();
      renderMembers();
      ensureMyTeamPhoto();
      if (lastGoalDocs.length) renderGoals(lastGoalDocs);
      refreshChat();
      Array.from(document.querySelectorAll('.team-item')).forEach((el) => el.classList.remove('active'));
    });

    goalsUnsub = teamRef.collection('goals').orderBy('createdAt', 'desc').onSnapshot((snap) => {
      renderGoals(snap.docs);
    }, (err) => console.warn('goals listener', err));

    messagesUnsub = teamRef.collection('messages').orderBy('createdAt', 'asc').limitToLast(50).onSnapshot({ includeMetadataChanges: true }, (snap) => {
      // Someone who just sent a message is no longer "typing".
      snap.docChanges().forEach((c) => {
        if (c.type === 'added') delete typingMap[c.doc.data().senderId];
      });
      renderTyping();
      renderMessages(snap.docs);
    }, (err) => console.warn('messages listener', err));

    // Read receipts: one small doc per member (teams/{id}/reads/{uid}).
    readsUnsub = teamRef.collection('reads').onSnapshot((snap) => {
      snap.docChanges().forEach((c) => {
        if (c.type === 'removed') { delete readsMap[c.doc.id]; return; }
        const d = c.doc.data({ serverTimestamps: 'estimate' });
        // msgAt = exact time of the newest message they read. Older receipts only have at.
        readsMap[c.doc.id] = Number(d.msgAt) || (d.at && d.at.toMillis ? d.at.toMillis() : 0);
      });
      refreshChat();
    }, (err) => console.warn('reads listener: ' + (err && err.code ? err.code : err) +
      ' — if this is permission-denied, publish the Firestore rules from README.md (the /reads block).', err));

    // Typing indicator: teams/{id}/typing/{uid} exists only while someone is typing.
    typingUnsub = teamRef.collection('typing').onSnapshot((snap) => {
      if (typingFirst) { typingFirst = false; return; }   // ignore stale docs from before we opened the chat
      snap.docChanges().forEach((c) => {
        const uid = c.doc.id;
        if (uid === currentUser.uid) return;
        const d = c.doc.data() || {};
        if (c.type === 'removed' || d.typing === false) { delete typingMap[uid]; return; }
        const member = currentTeamData && currentTeamData.members && currentTeamData.members[uid];
        typingMap[uid] = { name: (member && member.name) || d.name || 'Someone', at: Date.now() };
      });
      renderTyping();
    }, (err) => console.warn('typing listener', err));
    typingInterval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      Object.keys(typingMap).forEach((uid) => {
        if (now - typingMap[uid].at > TYPING_TTL) { delete typingMap[uid]; changed = true; }
      });
      if (changed) renderTyping();
    }, 1000);

    docsUnsub = teamRef.collection('docs').orderBy('updatedAt', 'desc').onSnapshot((snap) => {
      renderDocs(snap.docs);
    }, (err) => {
      console.warn('docs listener: ' + (err && err.code ? err.code : err) + ' — publish the Firestore rules from README.md (the /docs block).', err);
      const l = $('docs-list');
      if (l) l.innerHTML = '<div class="empty-hint">Could not load docs. Publish the updated Firestore rules from README.md (the /docs block).</div>';
    });

    rewardsUnsub = teamRef.collection('rewards').orderBy('createdAt', 'desc').onSnapshot((snap) => {
      renderRewards(snap.docs);
    }, (err) => console.warn('rewards listener', err));
  }

  function renderTeamHeader() {
    $('team-name').textContent = currentTeamData.name || 'Team';
    setChatTitle(currentTeamData.name || 'Team');
    updateChatTools();
    $('team-invite-code').textContent = currentTeamData.inviteCode || '------';
  }

  function renderMembers() {
    const members = currentTeamData.members || {};
    const avatarsEl = $('member-avatars');
    avatarsEl.innerHTML = '';
    ensureGoalStyles();
    Object.keys(members).forEach((uid) => {
      const el = document.createElement('div');
      el.className = 'avatar';
      el.title = members[uid].name || 'Member';
      paintMemberAvatar(el, uid, members[uid].name);
      avatarsEl.appendChild(el);
    });

    const listEl = $('members-list');
    listEl.innerHTML = '';
    Object.keys(members).forEach((uid) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      const isOwner = uid === currentTeamData.ownerId;
      row.innerHTML = `<span class="member-id"><span class="pf-avatar"></span><span>${escapeHtml(members[uid].name || 'Member')}</span></span>${isOwner ? '<span class="owner-tag">OWNER</span>' : ''}`;
      paintMemberAvatar(row.querySelector('.pf-avatar'), uid, members[uid].name);
      listEl.appendChild(row);
    });
    const mc = $('members-count');
    if (mc) mc.textContent = Object.keys(members).length;
    const sub = $('team-sub');
    if (sub) sub.textContent = Object.keys(members).length + ' MEMBERS';
  }

  // ---------- Goals ----------

  function goalCadenceLabel(cadence) {
    return { daily: 'Daily', weekly: 'Weekly', yearly: 'Yearly' }[cadence] || cadence;
  }

  // ----- per-person goal blocks -----
  // Every member gets a block (plus one block for team goals). Click a block to open it
  // and see that person's goals. When someone adds a goal you haven't opened yet, their
  // block lights up with a notification line until you click it.

  function ensureGoalStyles() {
    if (document.getElementById('gblock-styles')) return;
    const st = document.createElement('style');
    st.id = 'gblock-styles';
    st.textContent = `
      .gblock { border: 1px solid var(--line-soft); background: var(--surface2); border-radius: 12px; margin-bottom: 10px; overflow: hidden; transition: border-color .15s, box-shadow .15s; }
      .gblock:hover { border-color: var(--line); }
      .gblock.open { border-color: var(--line); }
      .gblock.has-new { border-color: var(--green); box-shadow: 0 0 0 1px var(--green-soft), 0 0 18px var(--green-soft); }
      .gblock-head { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 15px; background: transparent; border: 0; color: var(--text); cursor: pointer; text-align: left; font: inherit; }
      .gblock-avatar { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--lav), #5b5bd6); }
      .gblock.is-team .gblock-avatar { background: linear-gradient(135deg, var(--amber), #d9822b); color: #3a2200; font-size: 14px; }
      .gblock-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .gblock-name { font-weight: 700; font-size: 13.5px; display: flex; align-items: center; gap: 7px; }
      .gblock-you { font-size: 9px; font-weight: 800; letter-spacing: .06em; padding: 2px 6px; border-radius: 6px; background: var(--lav-soft); color: var(--lav); }
      .gblock-sub { font-size: 11px; color: var(--faint); }
      .gblock-new { display: none; align-items: center; gap: 5px; font-size: 10px; font-weight: 800; letter-spacing: .05em; padding: 3px 9px; border-radius: 999px; background: var(--green); color: #06281b; white-space: nowrap; }
      .gblock.has-new .gblock-new { display: inline-flex; animation: gblockPulse 1.6s ease-in-out infinite; }
      @keyframes gblockPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
      .gblock-chev { color: var(--faint); font-size: 12px; transition: transform .2s; }
      .gblock.open .gblock-chev { transform: rotate(180deg); }
      .gblock-note { display: none; margin: 0 15px 12px; padding: 8px 11px; border-radius: 9px; background: var(--green-soft); color: var(--text); font-size: 12px; cursor: pointer; }
      .gblock-note i { color: var(--green); margin-right: 6px; }
      .gblock-note b { font-weight: 700; }
      .gblock.has-new:not(.open) .gblock-note { display: block; }
      .gblock-body { display: none; padding: 2px 15px 6px; border-top: 1px solid var(--line-soft); }
      .gblock.open .gblock-body { display: block; padding-top: 12px; }
      .gblock-body .goal-card { background: var(--surface); }
      .gblock-empty { padding: 4px 0 10px; font-size: 12px; color: var(--faint); }
      .pf-avatar { width: 28px; height: 28px; flex: 0 0 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--lav), #5b5bd6); overflow: hidden; }
      .member-row .member-id { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
      .chat-msg:not(.mine) { margin-left: 34px; max-width: calc(85% - 34px); }
      .chat-msg.has-preview:not(.mine) { width: min(280px, calc(85% - 34px)); }
      .chat-msg .msg-avatar { position: absolute; left: -34px; top: 0; width: 26px; height: 26px; flex-basis: 26px; font-size: 9px; }
      .member-avatars .avatar { background-position: center; }
      .goal-tools { margin-left: auto; display: inline-flex; gap: 6px; }
      .goal-tool { width: 28px; height: 26px; display: inline-grid; place-items: center; border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 8px; cursor: pointer; font-size: 11px; }
      .goal-tool:hover { color: var(--text); border-color: var(--lav); }
      .goal-tool.danger:hover { color: var(--red); border-color: var(--red); }
      .goal-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .goal-edit input { flex: 1 1 220px; min-width: 0; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--lav); background: var(--surface2); color: var(--text); font: inherit; font-size: 13px; outline: none; }
      .goal-edit select { padding: 9px 10px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface2); color: var(--text); font: inherit; font-size: 12px; }
      .goal-edit .btn { padding: 8px 13px; }
      .goal-new-tag { display: inline-block; margin-left: 6px; padding: 2px 7px; border-radius: 6px; font-size: 9px; font-weight: 800; letter-spacing: .06em; background: var(--green); color: #06281b; vertical-align: middle; }
    `;
    document.head.appendChild(st);
  }

  function goalCreatedMs(goal) {
    return goal.createdAt && goal.createdAt.toMillis ? goal.createdAt.toMillis() : 0;
  }

  // Per-user, per-team "last opened" times, kept in this browser.
  function goalSeenKey() {
    return 'team_goal_seen_v1:' + (currentUser ? currentUser.uid : '') + ':' + currentTeamId;
  }

  function loadGoalSeen() {
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(goalSeenKey())); } catch (e) { seen = null; }
    if (!seen || typeof seen !== 'object') seen = {};
    if (!seen.blocks) seen.blocks = {};
    if (!seen.baseline) {                 // first visit: whatever already exists is not "new"
      seen.baseline = Date.now();
      saveGoalSeen(seen);
    }
    return seen;
  }

  function saveGoalSeen(seen) {
    try { localStorage.setItem(goalSeenKey(), JSON.stringify(seen)); } catch (e) { /* storage unavailable */ }
  }

  function markGoalBlockSeen(seen, key, goalList) {
    let newest = Date.now();
    goalList.forEach((d) => { newest = Math.max(newest, goalCreatedMs(d.data())); });
    seen.blocks[key] = newest;
    saveGoalSeen(seen);
  }

  // ----- edit / delete -----

  // Personal goal: its owner. Team goal: whoever created it. The team owner can manage any goal.
  function canManageGoal(goal) {
    if (!currentUser) return false;
    if (currentTeamData && currentTeamData.ownerId === currentUser.uid) return true;
    if (goal.type === 'team') return goal.createdBy === currentUser.uid;
    return goal.ownerId === currentUser.uid || (!goal.ownerId && goal.createdBy === currentUser.uid);
  }

  function goalToolsHtml() {
    return `<span class="goal-tools">
      <button type="button" class="goal-tool" data-act="edit" title="Edit goal" aria-label="Edit goal"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="goal-tool danger" data-act="delete" title="Delete goal" aria-label="Delete goal"><i class="fa-regular fa-trash-can"></i></button>
    </span>`;
  }

  function goalEditHtml(goal) {
    const opt = (v, label) => `<option value="${v}" ${goal.cadence === v ? 'selected' : ''}>${label}</option>`;
    return `<div class="goal-edit">
      <input type="text" class="goal-edit-title" maxlength="140" value="${escapeHtml(goal.title)}" aria-label="Goal title">
      <select class="goal-edit-cadence" aria-label="Cadence">${opt('daily', 'Daily')}${opt('weekly', 'Weekly')}${opt('yearly', 'Yearly')}</select>
      <button type="button" class="btn btn-green goal-edit-save"><i class="fa-solid fa-check"></i>Save</button>
      <button type="button" class="btn btn-quiet goal-edit-cancel">Cancel</button>
    </div>`;
  }

  function startGoalEdit(doc, goal, card) {
    if (editingGoalId && editingGoalId !== doc.id) {          // only one goal in edit mode at a time
      editingGoalId = null;
      renderGoals(lastGoalDocs);
      return;
    }
    editingGoalId = doc.id;
    const titleEl = card.querySelector('.goal-title');
    const metaEl = card.querySelector('.goal-meta');
    const holder = document.createElement('div');
    holder.innerHTML = goalEditHtml(goal);
    const form = holder.firstElementChild;
    titleEl.replaceWith(form);
    if (metaEl) metaEl.style.display = 'none';
    const input = form.querySelector('.goal-edit-title');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    const finish = () => { editingGoalId = null; renderGoals(lastGoalDocs); };
    const save = async () => {
      const title = input.value.trim();
      const cadence = form.querySelector('.goal-edit-cadence').value;
      if (!title) { input.focus(); return; }
      if (title === goal.title && cadence === goal.cadence) { finish(); return; }
      const btn = form.querySelector('.goal-edit-save');
      btn.disabled = true;
      try {
        await doc.ref.update({
          title, cadence,
          editedAt: firebase.firestore.FieldValue.serverTimestamp(),
          editedBy: currentUser.uid
        });
        finish();
      } catch (error) {
        btn.disabled = false;
        alert('Could not save the goal: ' + (error && error.message ? error.message : error));
      }
    };
    form.querySelector('.goal-edit-save').addEventListener('click', save);
    form.querySelector('.goal-edit-cancel').addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(); }
    });
  }

  async function deleteGoal(doc, goal) {
    if (!confirm('Delete this goal?\n\n"' + goal.title + '"\n\nThis removes it for everyone on the team.')) return;
    try {
      await doc.ref.delete();
    } catch (error) {
      const denied = error && error.code === 'permission-denied';
      alert(denied
        ? 'Firestore blocked the delete. Update your Firestore rules so members can delete goals (see README).'
        : 'Could not delete the goal: ' + (error && error.message ? error.message : error));
    }
  }

  function wireGoalTools(card, doc, goal) {
    const edit = card.querySelector('[data-act="edit"]');
    const del = card.querySelector('[data-act="delete"]');
    if (edit) edit.addEventListener('click', () => startGoalEdit(doc, goal, card));
    if (del) del.addEventListener('click', () => deleteGoal(doc, goal));
  }

  function buildTeamGoalCard(doc, goal, isNew) {
    const card = document.createElement('div');
    card.className = 'goal-card';
    const members = (currentTeamData && currentTeamData.members) || {};
    const participants = goal.participants || {};
    const doneCount = Object.values(participants).filter((s) => s === 'done').length;
    const total = Object.keys(participants).length;
    const myStatus = participants[currentUser.uid] || 'pending';
    const manage = canManageGoal(goal);
    card.innerHTML = `
      <div class="goal-top">
        <div style="min-width:0;flex:1;">
          <span class="badge badge-team">Team goal</span>${isNew ? '<span class="goal-new-tag">NEW</span>' : ''}
          <div class="goal-title">${escapeHtml(goal.title)}</div>
          <div class="goal-meta">${goalCadenceLabel(goal.cadence)} · ${doneCount}/${total} done${goal.editedAt ? ' · edited' : ''}</div>
        </div>
        <button type="button" class="done-toggle team-done-toggle ${myStatus === 'done' ? 'done' : ''}" data-goal-id="${doc.id}" title="Mark your part of this team goal as done">${myStatus === 'done' ? '✓ Done' : 'Mark done'}</button>
      </div>
      <div class="participants-grid" data-goal-id="${doc.id}">
        ${Object.keys(participants).map((uid) => {
          const name = (members[uid] && members[uid].name) || 'Member';
          const done = participants[uid] === 'done';
          const isSelf = uid === currentUser.uid;
          return `<span class="participant-chip ${done ? 'done' : ''} ${isSelf ? 'self' : ''}" data-uid="${uid}" title="${done ? 'Done' : 'Pending'}"><span class="dotc"></span>${escapeHtml(name)}</span>`;
        }).join('')}
      </div>
      ${manage ? `<div class="reactions-row">${goalToolsHtml()}</div>` : ''}`;
    // Your own part of the team goal: the Mark done button (or your own chip) toggles it.
    const toggleMine = () => {
      const newStatus = myStatus === 'done' ? 'pending' : 'done';
      doc.ref.update({ [`participants.${currentUser.uid}`]: newStatus })
        .catch((error) => alert('Could not update the goal: ' + (error && error.message ? error.message : error)));
    };
    card.querySelector('.team-done-toggle').addEventListener('click', toggleMine);
    card.querySelector('.participants-grid').addEventListener('click', (e) => {
      if (e.target.closest('.participant-chip.self')) toggleMine();
    });
    if (manage) wireGoalTools(card, doc, goal);
    return card;
  }

  function buildPersonalGoalCard(doc, goal, isNew) {
    const card = document.createElement('div');
    card.className = 'goal-card';
    const isMine = goal.ownerId === currentUser.uid;
    const reactions = goal.reactions || {};
    const myReaction = reactions[currentUser.uid];
    const reactCount = Object.keys(reactions).length;
    const manage = canManageGoal(goal);
    card.innerHTML = `
      <div class="goal-top">
        <div style="min-width:0;flex:1;">
          <span class="badge badge-self">${escapeHtml(goal.ownerName || 'Someone')}'s goal</span>${isNew ? '<span class="goal-new-tag">NEW</span>' : ''}
          <div class="goal-title">${escapeHtml(goal.title)}</div>
          <div class="goal-meta">${goalCadenceLabel(goal.cadence)}${goal.editedAt ? ' · edited' : ''}</div>
        </div>
        ${isMine ? `<button class="done-toggle ${goal.status === 'done' ? 'done' : ''}" data-goal-id="${doc.id}">${goal.status === 'done' ? '✓ Done' : 'Mark done'}</button>` : `<span class="done-toggle ${goal.status === 'done' ? 'done' : ''}" style="pointer-events:none;">${goal.status === 'done' ? '✓ Done' : 'Pending'}</span>`}
      </div>
      <div class="reactions-row">
        <button class="react-btn ${myReaction ? 'mine' : ''}" data-goal-id="${doc.id}">${REACT_EMOJI} ${reactCount || ''}</button>
        ${manage ? goalToolsHtml() : ''}
      </div>`;
    if (isMine) {
      card.querySelector('.done-toggle').addEventListener('click', () => {
        doc.ref.update({ status: goal.status === 'done' ? 'pending' : 'done' });
      });
    }
    card.querySelector('.react-btn').addEventListener('click', () => {
      const field = `reactions.${currentUser.uid}`;
      doc.ref.update({ [field]: myReaction ? firebase.firestore.FieldValue.delete() : REACT_EMOJI });
    });
    if (manage) wireGoalTools(card, doc, goal);
    return card;
  }

  function renderGoals(docs) {
    ensureGoalStyles();
    lastGoalDocs = docs;
    const list = $('goals-list');
    // Someone is typing in an edit box: keep it as is, and apply the update once they save or cancel.
    if (editingGoalId && list.querySelector('.goal-edit')) return;
    editingGoalId = null;
    const goalsCount = $('goals-count');
    if (goalsCount) goalsCount.textContent = docs.length;
    if (!currentUser || !currentTeamId) return;
    if (!docs.length) {
      list.innerHTML = '<div class="empty-hint">No goals yet. Add one above.</div>';
      updateGoalsTabBadge(0);
      return;
    }

    const members = (currentTeamData && currentTeamData.members) || {};
    const seen = loadGoalSeen();

    // Group the goals: team goals together, personal goals by owner.
    const teamGoals = [];
    const byOwner = {};
    docs.forEach((d) => {
      const g = d.data();
      if (g.type === 'team') { teamGoals.push(d); return; }
      const uid = g.ownerId || g.createdBy || 'unknown';
      (byOwner[uid] = byOwner[uid] || []).push(d);
    });

    // People order: me first, then the rest of the members, then anyone who left but still has goals.
    const uids = [];
    if (members[currentUser.uid] || byOwner[currentUser.uid] || ((currentTeamData && currentTeamData.memberIds) || []).indexOf(currentUser.uid) !== -1) uids.push(currentUser.uid);
    Object.keys(members).forEach((u) => { if (uids.indexOf(u) === -1) uids.push(u); });
    Object.keys(byOwner).forEach((u) => { if (uids.indexOf(u) === -1) uids.push(u); });

    const blocks = [];
    if (teamGoals.length) {
      blocks.push({ key: 'team', isTeam: true, name: 'Team goals', goals: teamGoals, mine: false });
    }
    uids.forEach((uid) => {
      const goals = byOwner[uid] || [];
      const fallbackName = goals.length ? (goals[0].data().ownerName || 'Member') : 'Member';
      blocks.push({
        key: 'u:' + uid, isTeam: false, uid,
        name: (members[uid] && members[uid].name) || fallbackName,
        goals, mine: uid === currentUser.uid
      });
    });

    let totalNew = 0;
    list.innerHTML = '';
    blocks.forEach((b) => {
      const lastSeen = Math.max(seen.baseline || 0, seen.blocks[b.key] || 0);
      // New = added by someone else after you last opened this block.
      const newDocs = b.goals.filter((d) => {
        const g = d.data();
        return g.createdBy !== currentUser.uid && goalCreatedMs(g) > lastSeen;
      });
      const isOpen = openGoalBlocks.has(b.key);
      const doneCount = b.goals.filter((d) => {
        const g = d.data();
        if (g.type === 'team') return Object.values(g.participants || {}).length && Object.values(g.participants || {}).every((s) => s === 'done');
        return g.status === 'done';
      }).length;
      const hasNew = newDocs.length > 0 && !isOpen;
      if (hasNew) totalNew += newDocs.length;

      const newest = newDocs.slice().sort((x, y) => goalCreatedMs(y.data()) - goalCreatedMs(x.data()))[0];
      const sub = b.goals.length
        ? b.goals.length + (b.goals.length === 1 ? ' goal' : ' goals') + ' · ' + doneCount + ' done'
        : 'No goals yet';

      const el = document.createElement('div');
      el.className = 'gblock' + (b.isTeam ? ' is-team' : '') + (isOpen ? ' open' : '') + (hasNew ? ' has-new' : '');
      el.dataset.block = b.key;
      el.innerHTML = `
        <button type="button" class="gblock-head" aria-expanded="${isOpen ? 'true' : 'false'}">
          <span class="gblock-avatar">${b.isTeam ? '<i class="fa-solid fa-users"></i>' : escapeHtml(initials(b.name))}</span>
          <span class="gblock-info">
            <span class="gblock-name">${escapeHtml(b.isTeam ? 'Team goals' : b.name)}${b.mine ? '<span class="gblock-you">YOU</span>' : ''}</span>
            <span class="gblock-sub">${sub}</span>
          </span>
          <span class="gblock-new"><i class="fa-solid fa-bell"></i><span class="gblock-new-n">${newDocs.length} NEW</span></span>
          <span class="gblock-chev"><i class="fa-solid fa-chevron-down"></i></span>
        </button>
        <div class="gblock-note"><i class="fa-solid fa-bell"></i>${newest
          ? (b.isTeam ? 'New team goal: ' : escapeHtml(b.name) + ' set a new goal: ') + '<b>' + escapeHtml(newest.data().title) + '</b>'
          : ''}</div>
        <div class="gblock-body"></div>`;

      if (!b.isTeam) paintMemberAvatar(el.querySelector('.gblock-avatar'), b.uid, b.name);
      const body = el.querySelector('.gblock-body');
      if (!b.goals.length) {
        body.innerHTML = '<div class="gblock-empty">' + (b.mine ? 'You haven\'t set a goal yet. Pick "My goal" above and add one.' : escapeHtml(b.name) + ' hasn\'t set a goal yet.') + '</div>';
      } else {
        b.goals.forEach((d) => {
          const g = d.data();
          const isNew = newDocs.indexOf(d) !== -1;
          body.appendChild(g.type === 'team' ? buildTeamGoalCard(d, g, isNew) : buildPersonalGoalCard(d, g, isNew));
        });
      }

      const toggle = () => {
        const open = !el.classList.contains('open');
        el.classList.toggle('open', open);
        el.querySelector('.gblock-head').setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          openGoalBlocks.add(b.key);
          el.classList.remove('has-new');                 // opening = you've seen it
          markGoalBlockSeen(loadGoalSeen(), b.key, b.goals);
          refreshGoalsTabBadge();
        } else {
          openGoalBlocks.delete(b.key);
        }
      };
      el.querySelector('.gblock-head').addEventListener('click', toggle);
      el.querySelector('.gblock-note').addEventListener('click', toggle);

      list.appendChild(el);

      // A block that is already open shows its goals right now, so it counts as seen.
      if (isOpen && newDocs.length) markGoalBlockSeen(seen, b.key, b.goals);
    });

    updateGoalsTabBadge(totalNew);
  }

  // Small green counter on the "Goals" tab while there are unopened new goals.
  function updateGoalsTabBadge(n) {
    const tab = document.querySelector('.team-tab[data-tab="goals"]');
    if (!tab) return;
    let badge = tab.querySelector('.new');
    if (!n) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'new'; tab.appendChild(badge); }
    badge.textContent = n + ' NEW';
  }

  function refreshGoalsTabBadge() {
    const n = document.querySelectorAll('#goals-list .gblock.has-new .gblock-new-n').length
      ? Array.from(document.querySelectorAll('#goals-list .gblock.has-new .gblock-new-n'))
          .reduce((sum, el) => sum + (parseInt(el.textContent, 10) || 0), 0)
      : 0;
    updateGoalsTabBadge(n);
  }

  async function addGoal() {
    const title = $('goal-title-input').value.trim();
    if (!title) return;
    const cadence = $('goal-cadence-select').value;
    const type = $('goal-type-select').value;
    const teamRef = window.lifeIsShortDb.collection('teams').doc(currentTeamId);
    const base = {
      type, title, cadence,
      createdBy: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (type === 'team') {
      const participants = {};
      (currentTeamData.memberIds || []).forEach((uid) => { participants[uid] = 'pending'; });
      await teamRef.collection('goals').add({ ...base, participants });
    } else {
      await teamRef.collection('goals').add({ ...base, ownerId: currentUser.uid, ownerName: displayName(), status: 'pending', reactions: {} });
    }
    $('goal-title-input').value = '';
  }

  // ---------- Chat ----------

  // ----- links: find URLs in a message and turn them into clickable links + preview cards -----

  const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  const META_KEY = 'team_link_meta_v1';
  const metaInflight = new Map();

  function normalizeUrl(s) {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
      return u.href;
    } catch (e) { return null; }
  }

  // Splits text into [{ text }, { text, href }, ...]
  function tokenize(text) {
    const out = [];
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      const trimmed = m[0].replace(/[.,!?;:'")\]]+$/, '');
      const href = normalizeUrl(trimmed);
      if (!href) continue;
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: trimmed, href });
      last = m.index + trimmed.length;
      URL_RE.lastIndex = last;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  function ytId(url) {
    const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function isImageUrl(u) {
    return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(u.pathname);
  }

  function readMetaCache() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeMetaCache(cache) {
    const keys = Object.keys(cache);
    if (keys.length > 120) keys.slice(0, keys.length - 120).forEach((k) => delete cache[k]);
    try { localStorage.setItem(META_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  // Title / image for a link. YouTube -> noembed.com, everything else -> microlink.io (both are free, CORS-enabled).
  // Results are cached in localStorage, and any failure simply leaves the basic card in place.
  function getLinkMeta(url, kind) {
    const cache = readMetaCache();
    if (cache[url]) return Promise.resolve(cache[url]);
    if (metaInflight.has(url)) return metaInflight.get(url);
    const endpoint = kind === 'yt'
      ? 'https://noembed.com/embed?url=' + encodeURIComponent(url)
      : 'https://api.microlink.io/?url=' + encodeURIComponent(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const p = fetch(endpoint, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        let meta = null;
        if (kind === 'yt') {
          if (j && j.title) meta = { title: j.title, site: j.author_name || 'YouTube' };
        } else if (j && j.status === 'success' && j.data) {
          const d = j.data;
          meta = { title: d.title || '', image: (d.image && d.image.url) || '', site: d.publisher || '' };
        }
        if (meta) { const c = readMetaCache(); c[url] = meta; writeMetaCache(c); }
        return meta;
      })
      .catch(() => null)
      .finally(() => { clearTimeout(timer); metaInflight.delete(url); });
    metaInflight.set(url, p);
    return p;
  }

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setBackground(node, url) {
    if (!/^https?:\/\//i.test(url)) return false;
    node.style.backgroundImage = 'url("' + url.replace(/["\\\n\r]/g, '') + '")';
    return true;
  }

  function buildPreview(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';

    // YouTube: thumbnail with a play button (click opens the video on YouTube)
    const vid = ytId(url);
    if (vid) {
      a.className = 'lp lp-yt';
      const thumb = mk('span', 'lp-thumb');
      setBackground(thumb, 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg');
      const play = mk('span', 'lp-play');
      play.innerHTML = '<i class="fa-solid fa-play"></i>';
      thumb.appendChild(play);
      const meta = mk('span', 'lp-meta');
      const title = mk('b', null, 'YouTube video');
      const sub = mk('em', null, 'youtube.com');
      meta.append(title, sub);
      a.append(thumb, meta);
      if (LINK_PREVIEWS) {
        getLinkMeta(url, 'yt').then((m) => {
          if (m && m.title) title.textContent = m.title;
          if (m && m.site) sub.textContent = m.site + ' · YouTube';
        });
      }
      return a;
    }

    // Direct image link: show the picture itself
    if (isImageUrl(u)) {
      a.className = 'lp lp-img';
      const img = new Image();
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.src = url;
      img.onerror = () => { a.remove(); };
      a.appendChild(img);
      return a;
    }

    // Any other site: favicon + domain right away, real title/thumbnail when the lookup returns
    a.className = 'lp lp-site';
    const thumb = mk('span', 'lp-thumb');
    thumb.hidden = true;
    const meta = mk('span', 'lp-meta');
    const title = mk('b', null, host);
    const sub = mk('em');
    const fav = new Image();
    fav.alt = '';
    fav.referrerPolicy = 'no-referrer';
    fav.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(u.hostname) + '&sz=64';
    fav.onerror = () => { fav.remove(); };
    sub.append(fav, mk('span', null, host + (u.pathname !== '/' ? u.pathname : '')));
    meta.append(title, sub);
    a.append(thumb, meta);
    if (LINK_PREVIEWS) {
      getLinkMeta(url, 'site').then((m) => {
        if (!m) return;
        if (m.title) title.textContent = m.title;
        if (m.image && setBackground(thumb, m.image)) thumb.hidden = false;
      });
    }
    return a;
  }

  // ----- message elements -----

  function isOwner() {
    return !!(currentUser && currentTeamData && currentTeamData.ownerId === currentUser.uid);
  }

  function memberName(uid) {
    const m = currentTeamData && currentTeamData.members && currentTeamData.members[uid];
    return (m && m.name) || 'Member';
  }

  // ----- replies (WhatsApp style: quote in the bubble, bar above the input) -----

  function snippet(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function buildQuote(reply) {
    const q = mk('div', 'msg-quote');
    if (reply.id) q.dataset.id = reply.id;
    q.append(mk('b', null, reply.name || 'Someone'), mk('span', null, snippet(reply.text, 70)));
    q.title = 'Jump to the original message';
    return q;
  }

  function updateReplyBar() {
    const bar = $('reply-bar');
    if (!bar) return;
    bar.hidden = !replyTo;
    if (!replyTo) return;
    $('reply-bar-name').textContent = 'Replying to ' + (replyTo.name || 'Someone');
    $('reply-bar-text').textContent = snippet(replyTo.text, 70);
  }

  function startReply(id) {
    const doc = lastMsgDocs.find((d) => d.id === id);
    if (!doc) return;
    const m = doc.data();
    replyTo = { id: id, name: m.senderName || memberName(m.senderId), text: m.text || '' };
    updateReplyBar();
    const input = $('chat-input');
    if (input) {
      input.placeholder = 'Reply to ' + (replyTo.name || 'Someone') + '…';
      input.focus();
    }
    const wrap = $('chat-messages');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }

  function clearReply() {
    replyTo = null;
    updateReplyBar();
    const input = $('chat-input');
    if (input) input.placeholder = 'Message your team…';
  }

  function jumpToMessage(id) {
    const node = msgEls.get(id);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('flash');
    void node.offsetWidth;                 // restart the highlight animation
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1400);
  }


  function buildMessage(doc) {
    const msg = doc.data();

    // Old-style "📄 Shared a doc" bubbles with a card are no longer shown: only the single doc line below appears.
    if (msg.kind !== 'system' && msg.sharedDocRef && msg.sharedDocRef.id) {
      const legacy = mk('div', 'chat-system');
      legacy.dataset.id = doc.id;
      legacy.hidden = true;
      legacy.style.display = 'none';
      return legacy;
    }

    // The one doc message: a rectangular line ("Rahul added you to …") with a button that opens the doc popup.
    if (msg.kind === 'system') {
      const sys = mk('div', 'chat-system');
      sys.dataset.id = doc.id;
      if (msg.sharedDocRef && msg.sharedDocRef.id) {
        const link = mk('button', 'chat-system-doc');
        link.type = 'button';
        link.innerHTML = '<i class="fa-solid fa-file-lines"></i><span>' + escapeHtml(msg.sharedDocRef.title || 'Shared doc') +
          '</span><i class="fa-solid fa-arrow-up-right-from-square"></i>';
        link.addEventListener('click', () => {
          if (!teamDocs.some((x) => x.id === msg.sharedDocRef.id)) { alert('This doc is no longer available (it may have been deleted).'); return; }
          openDocModal(msg.sharedDocRef.id);
        });
        sys.appendChild(mk('span', 'chat-system-text', msg.text || ''));
        sys.appendChild(link);
      } else {
        sys.appendChild(mk('span', 'chat-system-text', msg.text || ''));
      }
      sys.appendChild(mk('span', 'time', formatTime(msg.createdAt)));
      return sys;
    }

    const mine = msg.senderId === currentUser.uid;
    const node = mk('div', 'chat-msg' + (mine ? ' mine' : ''));
    node.dataset.id = doc.id;

    if (!mine) {
      ensureGoalStyles();
      node.appendChild(mk('span', 'pf-avatar msg-avatar'));
      node.appendChild(mk('div', 'sender', msg.senderName || 'Someone'));
    }
    if (msg.replyTo && (msg.replyTo.text || msg.replyTo.id)) node.appendChild(buildQuote(msg.replyTo));

    const body = mk('div', 'msg-text');
    const urls = [];
    tokenize(msg.text || '').forEach((tok) => {
      if (tok.href) {
        const link = mk('a', 'chat-link', tok.text.length > 48 ? tok.text.slice(0, 45) + '…' : tok.text);
        link.href = tok.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
        link.title = tok.href;
        body.appendChild(link);
        if (!urls.includes(tok.href)) urls.push(tok.href);
      } else {
        body.appendChild(document.createTextNode(tok.text));
      }
    });
    node.appendChild(body);

    if (urls.length) {
      const wrap = mk('div', 'msg-previews');
      urls.slice(0, MAX_PREVIEWS).forEach((u) => wrap.appendChild(buildPreview(u)));
      node.appendChild(wrap);
      node.classList.add('has-preview');
    }

    const foot = mk('div', 'msg-foot');
    foot.append(mk('span', 'time'), mk('span', 'ticks'), mk('span', 'seen-label'));
    node.appendChild(foot);

    const replyBtn = mk('button', 'msg-reply');
    replyBtn.type = 'button';
    replyBtn.title = 'Reply';
    replyBtn.setAttribute('aria-label', 'Reply to this message');
    replyBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
    node.appendChild(replyBtn);

    const del = mk('button', 'msg-del');
    del.type = 'button';
    del.title = 'Delete message';
    del.setAttribute('aria-label', 'Delete message');
    del.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
    node.appendChild(del);
    return node;
  }

  // Time, delivery ticks, "Seen by …" and delete-button visibility — cheap to redo whenever anything changes.
  function updateMessageMeta(node, doc, isLastMine) {
    const msg = doc.data({ serverTimestamps: 'estimate' });
    if (msg.kind === 'system' || (msg.sharedDocRef && msg.sharedDocRef.id)) {
      const time = node.querySelector('.time');
      if (time) time.textContent = formatTime(msg.createdAt);
      return;
    }
    const mine = msg.senderId === currentUser.uid;
    if (!mine) {
      const memberName = (currentTeamData && currentTeamData.members && currentTeamData.members[msg.senderId] && currentTeamData.members[msg.senderId].name) || msg.senderName;
      paintMemberAvatar(node.querySelector('.msg-avatar'), msg.senderId, memberName);
    }
    node.querySelector('.time').textContent = formatTime(msg.createdAt);
    node.querySelector('.msg-del').hidden = !(mine || isOwner());

    const ticks = node.querySelector('.ticks');
    const label = node.querySelector('.seen-label');
    if (!mine) { ticks.hidden = true; label.hidden = true; return; }

    const ts = msg.createdAt && msg.createdAt.toMillis ? msg.createdAt.toMillis() : 0;
    const memberSet = new Set([].concat(Object.keys((currentTeamData && currentTeamData.members) || {}), (currentTeamData && currentTeamData.memberIds) || []));
    const others = Array.from(memberSet).filter((u) => u !== currentUser.uid);
    const seen = ts ? others.filter((u) => (readsMap[u] || 0) >= ts) : [];
    const names = seen.map(memberName);

    let icon = 'fa-solid fa-check';
    let cls = 'ticks';
    let title = 'Sent';
    if (doc.metadata.hasPendingWrites) { icon = 'fa-regular fa-clock'; title = 'Sending…'; }
    else if (seen.length) {
      icon = 'fa-solid fa-check-double';
      title = 'Seen by ' + names.join(', ');
      cls += ' seen';                       // green double tick as soon as someone has read it
    }
    ticks.hidden = false;
    ticks.className = cls;
    ticks.title = title;
    ticks.innerHTML = '<i class="' + icon + '"></i>';

    if (isLastMine && seen.length && !doc.metadata.hasPendingWrites) {
      label.hidden = false;
      label.textContent = seen.length === others.length && others.length === 1
        ? 'Seen'
        : 'Seen by ' + (names.length > 2 ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2) : names.join(', '));
    } else {
      label.hidden = true;
    }
  }

  function renderMessages(docs) {
    lastMsgDocs = docs;
    const wrap = $('chat-messages');
    if (!currentUser) return;

    if (!docs.length) {
      msgEls.clear();
      wrap.innerHTML = '<div class="chat-empty">No messages yet. Say hi 👋</div>';
      updateChatTools();
      return;
    }
    const placeholder = wrap.querySelector('.chat-empty');
    if (placeholder) placeholder.remove();

    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 90;
    const ids = new Set(docs.map((d) => d.id));
    msgEls.forEach((node, id) => { if (!ids.has(id)) { node.remove(); msgEls.delete(id); } });

    let lastMineId = null;
    docs.forEach((d) => { if (d.data().senderId === currentUser.uid) lastMineId = d.id; });

    let addedNew = false;
    let addedOthers = false;
    docs.forEach((doc, i) => {
      let node = msgEls.get(doc.id);
      if (!node) {
        node = buildMessage(doc);
        msgEls.set(doc.id, node);
        addedNew = true;
        if (doc.data().senderId !== currentUser.uid) addedOthers = true;
      }
      updateMessageMeta(node, doc, doc.id === lastMineId);
      if (wrap.children[i] !== node) wrap.insertBefore(node, wrap.children[i] || null);
    });

    if (chatInitial || forceScroll || (addedNew && nearBottom)) {
      wrap.scrollTop = wrap.scrollHeight;
      // images / link cards load later and grow the bubbles, so stick to the bottom once more
      setTimeout(() => { if (chatInitial || forceScroll) wrap.scrollTop = wrap.scrollHeight; forceScroll = false; }, 400);
    }
    chatInitial = false;
    updateChatTools();
    if (addedOthers || addedNew) scheduleMarkRead();
  }

  // Re-run the render with the docs we already have (team doc / read receipts changed).
  function refreshChat() {
    if (currentUser && currentTeamId && lastMsgDocs.length) renderMessages(lastMsgDocs);
    else updateChatTools();
  }

  function resetChatState() {
    readsMap = {};
    typingMap = {};
    typingFirst = true;
    lastMsgDocs = [];
    chatInitial = true;
    forceScroll = false;
    lastReadWriteFor = 0;
    readRetries = 0;
    clearReply();
    msgEls.clear();
    $('chat-messages').innerHTML = '<div class="chat-empty">Loading messages…</div>';
    renderTyping();
    updateChatTools();
  }

  function updateChatTools() {
    const btn = $('chat-clear-btn');
    if (!btn) return;
    btn.hidden = !(isOwner() && lastMsgDocs.length && currentTeamId);
  }

  // ----- read receipts -----

  function scheduleMarkRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(markChatRead, 350);
  }

  function markChatRead() {
    if (!currentUser || !currentTeamId) return;
    // Count as "seen" while the chat is on screen (background tabs stay unread).
    if (document.visibilityState !== 'visible') return;

    let newestOther = 0;
    let newestAny = 0;
    lastMsgDocs.forEach((d) => {
      const x = d.data({ serverTimestamps: 'estimate' });
      const t = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
      newestAny = Math.max(newestAny, t);
      if (x.senderId !== currentUser.uid) newestOther = Math.max(newestOther, t);
    });

    if (newestOther && newestOther > (readsMap[currentUser.uid] || 0) && lastReadWriteFor !== newestOther) {
      lastReadWriteFor = newestOther;
      window.lifeIsShortDb.collection('teams').doc(currentTeamId).collection('reads').doc(currentUser.uid)
        // msgAt is the exact time of the newest message they have read, so the sender compares
        // two real message timestamps instead of two server clocks.
        .set({ name: displayName(), at: firebase.firestore.FieldValue.serverTimestamp(), msgAt: newestOther }, { merge: true })
        .then(() => { readRetries = 0; })
        .catch((err) => {
          lastReadWriteFor = 0;                      // let the next attempt try again
          if (readRetries < 3) { readRetries++; setTimeout(scheduleMarkRead, 2500 * readRetries); }
          console.warn('read receipt not saved: ' + (err && err.code ? err.code : err) +
            '. If this is permission-denied, publish the Firestore rules from README.md (the /reads block).', err);
        });
    }
    // Clears the bell / sidebar badge for this team.
    if (window.teamNotify) window.teamNotify.markRead(currentTeamId, newestAny);
  }

  // ----- typing indicator -----

  function typingRef(teamId) {
    return window.lifeIsShortDb.collection('teams').doc(teamId).collection('typing').doc(currentUser.uid);
  }

  function onChatInput() {
    if (!currentUser || !currentTeamId) return;
    if (!$('chat-input').value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (!iAmTyping || now - lastTypingSent > 2500) {
      iAmTyping = true;
      typingTeamId = currentTeamId;
      lastTypingSent = now;
      typingRef(currentTeamId)
        .set({ name: displayName(), typing: true, at: firebase.firestore.FieldValue.serverTimestamp() })
        .catch((err) => console.warn('typing flag not saved (check Firestore rules for teams/{id}/typing)', err));
    }
    clearTimeout(stopTypingTimeout);
    stopTypingTimeout = setTimeout(stopTyping, 4000);
  }

  function stopTyping() {
    clearTimeout(stopTypingTimeout);
    if (!iAmTyping) return;
    iAmTyping = false;
    lastTypingSent = 0;
    const teamId = typingTeamId;
    typingTeamId = null;
    if (currentUser && teamId && window.lifeIsShortDb) typingRef(teamId).delete().catch(() => {});
  }

  function renderTyping() {
    const bar = $('typing-bar');
    if (!bar) return;
    const names = Object.keys(typingMap).map((u) => typingMap[u].name);
    if (!names.length) { bar.hidden = true; bar.textContent = ''; return; }
    const text = names.length === 1 ? names[0] + ' is typing'
      : names.length === 2 ? names[0] + ' and ' + names[1] + ' are typing'
      : 'Several people are typing';
    bar.textContent = '';
    const dots = mk('span', 'typing-dots');
    dots.innerHTML = '<i></i><i></i><i></i>';
    bar.append(dots, document.createTextNode(' ' + text));
    bar.hidden = false;
  }

  // ----- sending / deleting -----

  async function sendMessage(event) {
    event.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !currentTeamId) return;
    const reply = replyTo;
    input.value = '';
    stopTyping();
    forceScroll = true;
    try {
      const data = {
        senderId: currentUser.uid,
        senderName: displayName(),
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (reply) data.replyTo = reply;
      await window.lifeIsShortDb.collection('teams').doc(currentTeamId).collection('messages').add(data);
      if (reply && replyTo && replyTo.id === reply.id) clearReply();
    } catch (error) {
      console.error('sendMessage failed', error);
      input.value = text;
      alert('Could not send the message: ' + (error && error.message ? error.message : error));
    }
  }

  async function deleteMessage(id) {
    if (!currentTeamId || !id) return;
    if (!confirm('Delete this message for everyone?')) return;
    try {
      await window.lifeIsShortDb.collection('teams').doc(currentTeamId).collection('messages').doc(id).delete();
    } catch (error) {
      console.error('deleteMessage failed', error);
      alert('Could not delete the message: ' + (error && error.message ? error.message : error) +
        '\n\nCheck that your Firestore rules allow deleting from teams/{teamId}/messages (see FIRESTORE-RULES.md).');
    }
  }

  async function clearChat() {
    if (!isOwner() || !currentTeamId) return;
    if (!confirm('Delete the ENTIRE chat history of "' + (currentTeamData.name || 'this team') + '" for everyone? This cannot be undone.')) return;
    const db = window.lifeIsShortDb;
    const col = db.collection('teams').doc(currentTeamId).collection('messages');
    try {
      for (;;) {
        const snap = await col.limit(200).get();
        if (snap.empty) break;
        try {
          const batch = db.batch();
          snap.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        } catch (batchErr) {
          // Fallback if the rules engine rejects a big batch: delete one by one.
          await Promise.all(snap.docs.map((d) => d.ref.delete()));
        }
      }
    } catch (error) {
      console.error('clearChat failed', error);
      alert('Could not clear the chat: ' + (error && error.message ? error.message : error));
    }
  }

  // ---------- Rewards ----------

  function renderRewards(docs) {
    const list = $('rewards-list');
    if (!docs.length) {
      list.innerHTML = '<div class="empty-hint">No wins posted yet. Celebrate one above.</div>';
      return;
    }
    list.innerHTML = '';
    docs.forEach((doc) => {
      const reward = doc.data();
      const cheers = reward.cheers || {};
      const mine = !!cheers[currentUser.uid];
      const card = document.createElement('div');
      card.className = 'reward-card';
      card.innerHTML = `
        <div><i class="fa-solid fa-trophy"></i><strong>${escapeHtml(reward.title)}</strong><div class="goal-meta">by ${escapeHtml(reward.createdByName || 'Someone')}</div></div>
        <button class="cheer-btn ${mine ? 'mine' : ''}">👏 ${Object.keys(cheers).length}</button>`;
      card.querySelector('.cheer-btn').addEventListener('click', () => {
        const field = `cheers.${currentUser.uid}`;
        doc.ref.update({ [field]: mine ? firebase.firestore.FieldValue.delete() : true });
      });
      list.appendChild(card);
    });
  }

  async function addReward() {
    const title = $('reward-title-input').value.trim();
    if (!title) return;
    await window.lifeIsShortDb.collection('teams').doc(currentTeamId).collection('rewards').add({
      title,
      createdBy: currentUser.uid,
      createdByName: displayName(),
      cheers: {},
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    $('reward-title-input').value = '';
  }


  // ---------- Shared docs (read / write per doc) ----------
  // The rules of the game for a shared doc:
  //   * permission 'read'  -> the doc is LOCKED. Only the person who shared it may type,
  //                           and only that person can ever open it up again. No teammate
  //                           (not even the team owner) can write, and nobody but the
  //                           owner can flip read -> write.
  //   * permission 'write' -> every member can type, autosaves as they go.
  // Both rules are enforced twice: in the UI here and in the Firestore rules
  // (README.md), so a hand-edited client still cannot write to a locked doc.

  const Docs = window.InfiniteDocs;
  const DOC_MAX = Docs.DOC_MAX;

  // Docs are written by other people, so everything is rendered through this whitelist.
  function cleanDocHtml(html) { return Docs.clean(html); }

  function tsMs(ts) { return ts && ts.toMillis ? ts.toMillis() : 0; }
  function permLabel(p) { return p === 'write' ? 'Can edit' : 'View only'; }
  // Every "may I touch this doc" question goes through the one shared ACL in
  // doc-attrib.js, so the Team page and the Notepad can never disagree about it.
  function amTeamMember() {
    const ids = currentTeamData && currentTeamData.memberIds;
    return !!(currentUser && Array.isArray(ids) && ids.indexOf(currentUser.uid) !== -1);
  }
  function docAcl(d) { return Docs.acl(d, currentUser && currentUser.uid, isOwner() ? currentUser.uid : null, amTeamMember()); }
  function isDocOwner(d) { return docAcl(d).owner; }
  function docCanEdit(d) { return docAcl(d).canEdit; }
  function docIsLocked(d) { return docAcl(d).locked; }
  function docCanDelete(d) { return docAcl(d).canDelete; }
  function docsCol() { return window.lifeIsShortDb.collection('teams').doc(currentTeamId).collection('docs'); }

  // Straight from the live snapshot — every write path re-checks with these two.
  function liveDoc(id) { return teamDocs.find((x) => x.id === id) || null; }
  function liveCanEdit(id) { const cur = liveDoc(id); return !!(cur && docCanEdit(cur.data())); }

  // Stamp WHO WROTE WHICH PART: new / changed lines get my name, everything that is
  // still identical to the stored copy keeps the name it already had.
  function tagContribution(html, d) {
    return Docs.attribute(html, (d && d.body) || '',
      { id: currentUser ? currentUser.uid : '', name: displayName() },
      { id: (d && d.ownerId) || '', name: (d && d.ownerName) || 'Someone' });
  }

  function writtenByLabel(d) {
    const list = Docs.names((d && d.body) || '', (d && d.ownerId) || '');
    if (!list.length) return '';
    return ' · added by ' + list.slice(0, 4).join(', ') + (list.length > 4 ? ' +' + (list.length - 4) + ' more' : '');
  }


  function setDocStatus(msg, bad) {
    const el = $('doc-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = bad ? 'var(--red)' : '';
  }

  function resetDocsState() {
    clearTimeout(docSaveTimer);
    docSaveTimer = null;
    clearTimeout(modalSaveTimer);
    modalSaveTimer = null;
    closeDocModal(true);
    teamDocs = [];
    openDocId = null;
    pendingOpenDocId = null;
    docLoadedAt = 0;
    lockAllDocSurfaces();
    const v = $('doc-viewer'), l = $('docs-list-view');
    if (v) v.hidden = true;
    if (l) l.hidden = false;
    const c = $('docs-count');
    if (c) c.textContent = '0';
    const list = $('docs-list');
    if (list) list.innerHTML = '<div class="empty-hint">Loading docs…</div>';
  }

  function renderDocs(docs) {
    teamDocs = docs;
    const cnt = $('docs-count');
    if (cnt) cnt.textContent = String(docs.length);

    if (openDocId) {
      const cur = docs.find((x) => x.id === openDocId);
      if (!cur) closeDocViewer(true);          // deleted by someone else
      else fillViewer(cur, false);
    }
    if (pendingOpenDocId) {
      const p = docs.find((x) => x.id === pendingOpenDocId);
      if (p) { pendingOpenDocId = null; openDoc(p.id); }
    }

    // The chat popup stays live: it reuses the same docs listener, so teammate edits land there too.
    if (modalDocId) {
      const cur = docs.find((x) => x.id === modalDocId);
      if (!cur) closeDocModal(true);
      else fillDocModal(cur, false);
    }

    const list = $('docs-list');
    if (!list) return;
    if (!docs.length) {
      list.innerHTML = '<div class="empty-hint">No shared docs yet. Create one above, or press <b>Share with team</b> in Notepad &amp; Docs.</div>';
      return;
    }
    list.innerHTML = '';
    docs.forEach((doc) => {
      const d = doc.data({ serverTimestamps: 'estimate' });
      const row = mk('div', 'doc-row');
      row.tabIndex = 0;
      const who = Docs.names(d.body || '', d.ownerId || '');
      row.innerHTML = '<i class="fa-solid fa-file-lines doc-ico"></i>' +
        '<div class="doc-row-main"><b>' + escapeHtml(d.title || 'Untitled doc') + '</b><span>' +
        escapeHtml(d.ownerName || 'Someone') + ' · ' + escapeHtml(formatTime(d.updatedAt) || 'just now') +
        (d.updatedBy && d.updatedBy !== d.ownerId ? ' · edited by ' + escapeHtml(d.updatedByName || 'a member') : '') +
        (who.length ? ' · written with ' + escapeHtml(who.slice(0, 3).join(', ')) + (who.length > 3 ? ' +' + (who.length - 3) + ' more' : '') : '') +
        '</span></div>';
      // Access control: only the person who shared the doc can flip it from here, and
      // read -> write asks first. Everyone else only sees the state — and the Firestore
      // rules refuse the same change server side, so a tampered row cannot help either.
      const badge = mk('span', 'perm-badge ' + (d.permission === 'write' ? 'edit' : 'view'));
      badge.innerHTML = (d.permission === 'write' ? '<i class="fa-solid fa-pen"></i>' : '<i class="fa-solid fa-lock"></i>') + ' ' + permLabel(d.permission);
      if (isDocOwner(d)) {
        badge.classList.add('is-toggle');
        badge.tabIndex = 0;
        badge.title = 'Change who can edit this doc';
        const flip = async (e) => {
          e.stopPropagation();
          const wanted = d.permission === 'write' ? 'read' : 'write';
          if (wanted === 'write' && !confirm('Open “' + (d.title || 'this doc') + '” so everyone in the team can edit it?\nYou can lock it again any time.')) return;
          try { await doc.ref.update({ permission: wanted }); }
          catch (error) { alert('Could not change permission: ' + (error && error.message ? error.message : error)); }
        };
        badge.addEventListener('click', flip);
        badge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(e); } });
      } else {
        badge.title = d.permission === 'write'
          ? 'Everyone in this team can edit — only ' + (d.ownerName || 'the owner') + ' can change this'
          : 'Locked (view only) — only ' + (d.ownerName || 'the owner') + ' can let people edit';
      }
      row.appendChild(badge);
      if (docCanDelete(d)) {
        const del = mk('button', 'doc-row-del');
        del.type = 'button';
        del.title = 'Delete doc';
        del.setAttribute('aria-label', 'Delete doc');
        del.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteDoc(doc.id); });
        row.appendChild(del);
      }
      row.addEventListener('click', () => openDoc(doc.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDoc(doc.id); });
      list.appendChild(row);
    });

  }

  // Docs tab rows now open the same big scrollable popup as the chat link (no inline viewer any more).
  function openDoc(id, switchTab) {
    if (!teamDocs.some((x) => x.id === id)) return;
    if (switchTab) showTab('docs');
    openDocModal(id);
  }

  function closeDocViewer(silent) {
    if (docSaveTimer && !silent) saveDoc();
    clearTimeout(docSaveTimer);
    docSaveTimer = null;
    openDocId = null;
    docLoadedAt = 0;
    setDocStatus('');
    $('doc-viewer').hidden = true;
    $('docs-list-view').hidden = false;
  }

  // Lock one doc surface without a doc. Everything starts locked and is only opened
  // by applyDocMode once a real snapshot has proved the viewer may write, so a doc
  // that is still loading, or a viewer who is not allowed in, is never editable.
  function lockDocSurface(prefix) {
    const titleEl = $(prefix + '-title'), bodyEl = $(prefix + '-body'), bar = $(prefix + '-toolbar');
    if (titleEl) {
      titleEl.readOnly = true;
      titleEl.setAttribute('aria-readonly', 'true');
    }
    if (bodyEl) {
      bodyEl.contentEditable = 'false';
      bodyEl.setAttribute('aria-readonly', 'true');
      bodyEl.setAttribute('spellcheck', 'false');
      bodyEl.classList.add('doc-locked');
    }
    if (bar) {
      bar.hidden = true;
      bar.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }
  }

  function lockAllDocSurfaces() {
    lockDocSurface('doc');
    lockDocSurface('doc-modal');
  }

  // Lock or unlock one doc surface ('doc' = Docs tab viewer, 'doc-modal' = chat popup).
  // Runs on every snapshot, so if the owner locks the doc while you are reading it,
  // the surface goes read-only straight away.
  function applyDocMode(prefix, d) {
    const acl = docAcl(d);
    const can = acl.canEdit, locked = acl.locked, owner = acl.owner;
    const titleEl = $(prefix + '-title'), bodyEl = $(prefix + '-body'), bar = $(prefix + '-toolbar');

    if (titleEl) {
      titleEl.readOnly = !can;
      titleEl.setAttribute('aria-readonly', can ? 'false' : 'true');
    }
    if (bodyEl) {
      bodyEl.contentEditable = can ? 'true' : 'false';
      bodyEl.setAttribute('aria-readonly', can ? 'false' : 'true');
      bodyEl.setAttribute('spellcheck', can ? 'true' : 'false');
      bodyEl.classList.toggle('doc-locked', locked);
    }
    if (bar) {
      bar.hidden = !can;
      bar.querySelectorAll('button').forEach((b) => { b.disabled = !can; });
    }

    // Access control: rendered for the doc owner only. Hidden AND disabled for
    // everybody else, so no teammate can ever switch a locked doc back to "can edit".
    const sel = $(prefix + '-perm-select'), badge = $(prefix + '-perm-badge');
    if (sel) {
      sel.hidden = !owner;
      sel.disabled = !owner;
      if (owner) sel.value = acl.perm;
    }
    if (badge) {
      badge.hidden = owner;
      badge.className = 'perm-badge ' + (acl.perm === 'write' ? 'edit' : 'view');
      badge.innerHTML = (acl.perm === 'write' ? '<i class="fa-solid fa-pen"></i>' : '<i class="fa-solid fa-lock"></i>') +
        ' ' + permLabel(acl.perm);
      badge.title = acl.perm === 'write'
        ? 'Everyone in this team can edit this doc'
        : 'Locked — only ' + ((d.ownerName || 'the owner') + ' can let people edit');
    }
    const del = $(prefix + '-delete');
    if (del) del.hidden = !acl.canDelete;
    return acl;
  }

  function docMetaText(d, can) {
    const ownerName = d.ownerName || 'Someone';
    return 'By ' + ownerName +
      (d.updatedAt ? ' · last edited ' + formatTime(d.updatedAt) + (d.updatedByName ? ' by ' + d.updatedByName : '') : '') +
      writtenByLabel(d) +
      (can ? '' : ' · locked (view only) — only ' + ownerName + ' can change this');
  }

  function fillViewer(doc, force) {
    const d = doc.data({ serverTimestamps: 'estimate' });
    const bodyEl = $('doc-body');
    const titleEl = $('doc-title');
    const stamp = tsMs(d.updatedAt);
    const editing = document.activeElement === bodyEl || document.activeElement === titleEl;
    const locked = docIsLocked(d);

    if (force || locked || (!editing && stamp !== docLoadedAt)) {
      titleEl.value = d.title || '';
      bodyEl.innerHTML = cleanDocHtml(d.body);
      docLoadedAt = stamp;
      $('doc-notice').hidden = true;
    } else if (editing && stamp !== docLoadedAt) {
      if (d.updatedBy === (currentUser && currentUser.uid)) docLoadedAt = stamp;   // that was my own save coming back
      else $('doc-notice').hidden = false;                                          // don't clobber what they're typing
    }

    const mode = applyDocMode('doc', d);
    $('doc-meta').textContent = docMetaText(d, mode.canEdit);
    if (!docSaveTimer) setDocStatus(mode.canEdit ? 'Autosaves as you type' : 'View only');
  }


  // Show the freshly stored stamps (who wrote what) without ever moving the caret.
  function showStampsOn(el, html) {
    if (!el || document.activeElement === el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function scheduleDocSave() {
    if (!liveCanEdit(openDocId)) return;                      // read-only: nothing to save
    clearTimeout(docSaveTimer);
    setDocStatus('Editing…');
    docSaveTimer = setTimeout(saveDoc, 700);
  }

  async function saveDoc() {
    clearTimeout(docSaveTimer);
    docSaveTimer = null;
    const cur = liveDoc(openDocId);
    if (!cur) return;
    const d = cur.data();
    if (!docCanEdit(d)) {                                      // access changed while typing
      setDocStatus('Access changed — this doc is view only now', true);
      fillViewer(cur, true);
      return;
    }
    const html = tagContribution(cleanDocHtml($('doc-body').innerHTML), d);
    if (html.length > DOC_MAX) { setDocStatus('Too large to save (limit ≈ 200 KB)', true); return; }
    setDocStatus('Saving…');
    try {
      await cur.ref.update({
        title: ($('doc-title').value || '').trim().slice(0, 120) || 'Untitled doc',
        body: html,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser.uid,
        updatedByName: displayName()
      });
      showStampsOn($('doc-body'), html);
      if (!docSaveTimer) setDocStatus('Saved ✓');
    } catch (error) {
      console.error('saveDoc failed', error);
      setDocStatus('Could not save: ' + (error && error.code === 'permission-denied' ? 'this doc is view only for you (or the /docs rules are not published)' : (error && error.message) || error), true);
    }
  }

  // Only the person who shared the doc can ever get here — and the Firestore rules
  // say the same thing, so read -> write cannot be forced from a teammate's browser.
  async function changeDocPermission(prefix, id) {
    const sel = $(prefix + '-perm-select');
    if (!sel || !currentUser) return;
    const cur = liveDoc(id);
    const d = cur ? cur.data() : null;
    const stored = d && d.permission === 'write' ? 'write' : 'read';
    if (!cur || !isDocOwner(d)) {
      if (d) sel.value = stored;
      alert('Only ' + ((d && d.ownerName) || 'the owner') + ' can change who can edit this doc.');
      return;
    }
    const wanted = sel.value === 'write' ? 'write' : 'read';
    if (wanted === stored) return;
    if (wanted === 'write' && !confirm('Open this doc up so everyone in the team can edit it?\nYou can lock it again any time.')) {
      sel.value = 'read';
      return;
    }
    try { await cur.ref.update({ permission: wanted }); }
    catch (error) { alert('Could not change permission: ' + (error && error.message ? error.message : error)); }
  }


  // ---------- Big popup viewer (docs opened from a chat card) ----------
  // Same doc record and same live listener as the Docs tab, just a second surface
  // with its own id prefix so both can be open at the same time.

  function setModalStatus(msg, bad) {
    const el = $('doc-modal-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = bad ? 'var(--red)' : '';
  }

  function openDocModal(id) {
    const doc = teamDocs.find((x) => x.id === id);
    if (!doc) { alert('This doc is no longer available (it may have been deleted).'); return; }
    modalDocId = id;
    modalLoadedAt = 0;
    const dlg = $('doc-modal');
    if (dlg && !dlg.open) dlg.showModal();
    fillDocModal(doc, true);
  }

  function closeDocModal(silent) {
    if (modalSaveTimer && !silent) saveDocModal();
    clearTimeout(modalSaveTimer);
    modalSaveTimer = null;
    modalDocId = null;
    modalLoadedAt = 0;
    setModalStatus('');
    const dlg = $('doc-modal');
    if (dlg && dlg.open) dlg.close();
  }

  function fillDocModal(doc, force) {
    const d = doc.data({ serverTimestamps: 'estimate' });
    const titleEl = $('doc-modal-title'), bodyEl = $('doc-modal-body');
    const stamp = tsMs(d.updatedAt);
    const editing = document.activeElement === bodyEl || document.activeElement === titleEl;
    const locked = docIsLocked(d);

    if (force || locked || (!editing && stamp !== modalLoadedAt)) {
      titleEl.value = d.title || '';
      bodyEl.innerHTML = cleanDocHtml(d.body);
      modalLoadedAt = stamp;
      $('doc-modal-notice').hidden = true;
    } else if (editing && stamp !== modalLoadedAt) {
      if (d.updatedBy === (currentUser && currentUser.uid)) modalLoadedAt = stamp;
      else $('doc-modal-notice').hidden = false;
    }

    const mode = applyDocMode('doc-modal', d);
    $('doc-modal-meta').textContent = docMetaText(d, mode.canEdit);
    if (!modalSaveTimer) setModalStatus(mode.canEdit ? 'Autosaves as you type' : 'View only');
  }


  function scheduleDocModalSave() {
    if (!liveCanEdit(modalDocId)) return;                        // read-only: nothing to save
    clearTimeout(modalSaveTimer);
    setModalStatus('Editing…');
    modalSaveTimer = setTimeout(saveDocModal, 700);
  }

  async function saveDocModal() {
    clearTimeout(modalSaveTimer);
    modalSaveTimer = null;
    const cur = liveDoc(modalDocId);
    if (!cur) return;
    const d = cur.data();
    if (!docCanEdit(d)) {
      setModalStatus('Access changed — this doc is view only now', true);
      fillDocModal(cur, true);
      return;
    }
    const html = tagContribution(cleanDocHtml($('doc-modal-body').innerHTML), d);
    if (html.length > DOC_MAX) { setModalStatus('Too large to save (limit ≈ 200 KB)', true); return; }
    setModalStatus('Saving…');
    try {
      await cur.ref.update({
        title: ($('doc-modal-title').value || '').trim().slice(0, 120) || 'Untitled doc',
        body: html,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser.uid,
        updatedByName: displayName()
      });
      showStampsOn($('doc-modal-body'), html);
      if (!modalSaveTimer) setModalStatus('Saved ✓');
    } catch (error) {
      console.error('saveDocModal failed', error);
      setModalStatus('Could not save: ' + (error && error.code === 'permission-denied' ? 'this doc is view only for you' : (error && error.message) || error), true);
    }
  }

  async function changeDocModalPermission() {
    await changeDocPermission('doc-modal', modalDocId);
  }


  function postDocMessage(teamId, docId, title, permission, verb) {
    return window.lifeIsShortDb.collection('teams').doc(teamId).collection('messages').add({
      senderId: currentUser.uid,
      senderName: displayName(),
      kind: 'system',
      text: displayName() + ' ' + String(verb).toLowerCase() + ' "' + title + '" — ' + (permission === 'write' ? 'everyone can edit' : 'view only'),
      sharedDocRef: { id: docId, title, permission },
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function createDoc() {
    if (!currentTeamId) return;
    const input = $('new-doc-title');
    const title = input.value.trim() || 'Untitled doc';
    const permission = $('new-doc-perm').value === 'read' ? 'read' : 'write';
    const ref = docsCol().doc();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    pendingOpenDocId = ref.id;
    try {
      await ref.set({
        title, body: '', ownerId: currentUser.uid, ownerName: displayName(), permission,
        createdAt: ts, updatedAt: ts, updatedBy: currentUser.uid, updatedByName: displayName()
      });
      input.value = '';
      postDocMessage(currentTeamId, ref.id, title, permission, 'Created').catch(() => {});
    } catch (error) {
      pendingOpenDocId = null;
      console.error('createDoc failed', error);
      alert('Could not create the doc: ' + (error && error.message ? error.message : error) + '\n\nPublish the Firestore rules from README.md (the /docs block).');
    }
  }

  async function deleteDoc(id) {
    const doc = teamDocs.find((x) => x.id === id);
    if (!doc || !docCanDelete(doc.data())) return;
    if (!confirm('Delete "' + (doc.data().title || 'Untitled doc') + '" for everyone in the team?')) return;
    try { await doc.ref.delete(); }
    catch (error) { alert('Could not delete the doc: ' + (error && error.message ? error.message : error)); }
  }

  // ---------- Wiring ----------

  function showTab(name) {
    document.querySelectorAll('.team-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    ['goals', 'docs', 'rewards', 'members'].forEach((n) => {
      const panel = $('tab-' + n);
      if (panel) panel.hidden = n !== name;
    });
  }

  function setupTabs() {
    document.querySelectorAll('.team-tab').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
  }

  document.addEventListener('lifeIsShortProfileReady', ensureMyTeamPhoto);

  function setupStaticButtons() {
    $('create-team-btn').addEventListener('click', () => currentUser ? createTeam() : promptSignIn());
    $('join-team-btn').addEventListener('click', () => currentUser ? joinTeam() : promptSignIn());
    $('leave-team-btn').addEventListener('click', leaveTeam);
    $('add-goal-btn').addEventListener('click', addGoal);
    $('add-reward-btn').addEventListener('click', addReward);
    $('add-doc-btn').addEventListener('click', createDoc);
    $('new-doc-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createDoc(); } });
    $('doc-back').addEventListener('click', () => closeDocViewer(false));
    $('doc-delete').addEventListener('click', () => { if (openDocId) deleteDoc(openDocId); });
    $('doc-perm-select').addEventListener('change', () => changeDocPermission('doc', openDocId));
    // Read-only is enforced for real here: while the doc is locked nothing can change
    // the body or the title. contentEditable=false already blocks typing, these
    // guards catch the rest (paste, drop, hand-made events from the console).
    const docGuard = () => liveCanEdit(openDocId);
    $('doc-title').addEventListener('beforeinput', (e) => { if (!docGuard()) e.preventDefault(); });
    $('doc-body').addEventListener('beforeinput', (e) => { if (!docGuard()) e.preventDefault(); });
    $('doc-title').addEventListener('input', scheduleDocSave);
    $('doc-body').addEventListener('input', scheduleDocSave);
    ['paste', 'drop'].forEach((evt) => {
      $('doc-body').addEventListener(evt, (e) => {
        e.preventDefault();
        if (!docGuard() || evt !== 'paste') return;   // locked: nothing gets in; drops stay plain
        document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
      });
    });
    $('doc-reload').addEventListener('click', () => {
      const cur = teamDocs.find((x) => x.id === openDocId);
      if (cur) fillViewer(cur, true);
    });
    document.querySelectorAll('[data-doc-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (!docGuard()) return;                      // read-only: no formatting either
        document.execCommand(b.dataset.docCmd, false, b.dataset.value || null);
        scheduleDocSave();
      });
    });

    window.addEventListener('beforeunload', () => { if (docSaveTimer) saveDoc(); if (modalSaveTimer) saveDocModal(); });

    // Big popup opened from a chat doc card
    $('doc-modal-close').addEventListener('click', () => closeDocModal(false));
    $('doc-modal-delete').addEventListener('click', () => { if (modalDocId) deleteDoc(modalDocId); });
    $('doc-modal-perm-select').addEventListener('change', changeDocModalPermission);
    const modalGuard = () => liveCanEdit(modalDocId);
    $('doc-modal-title').addEventListener('beforeinput', (e) => { if (!modalGuard()) e.preventDefault(); });
    $('doc-modal-body').addEventListener('beforeinput', (e) => { if (!modalGuard()) e.preventDefault(); });
    $('doc-modal-title').addEventListener('input', scheduleDocModalSave);
    $('doc-modal-body').addEventListener('input', scheduleDocModalSave);
    ['paste', 'drop'].forEach((evt) => {
      $('doc-modal-body').addEventListener(evt, (e) => {
        e.preventDefault();
        if (!modalGuard() || evt !== 'paste') return;
        document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
      });
    });
    $('doc-modal-reload').addEventListener('click', () => {
      const cur = teamDocs.find((x) => x.id === modalDocId);
      if (cur) fillDocModal(cur, true);
    });
    document.querySelectorAll('[data-modal-doc-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (!modalGuard()) return;
        document.execCommand(b.dataset.modalDocCmd, false, b.dataset.value || null);
        scheduleDocModalSave();
      });
    });

    $('doc-modal').addEventListener('cancel', (e) => { e.preventDefault(); closeDocModal(false); });
    $('doc-modal').addEventListener('close', () => {
      clearTimeout(modalSaveTimer);
      modalSaveTimer = null;
      modalDocId = null;
      modalLoadedAt = 0;
    });
    $('chat-form').addEventListener('submit', sendMessage);
    $('chat-input').addEventListener('input', onChatInput);
    $('chat-input').addEventListener('blur', stopTyping);
    $('chat-clear-btn').addEventListener('click', clearChat);
    $('chat-messages').addEventListener('click', (e) => {
      const replyBtn = e.target.closest('.msg-reply');
      if (replyBtn) {
        const target = replyBtn.closest('.chat-msg');
        if (target) startReply(target.dataset.id);
        return;
      }
      const quote = e.target.closest('.msg-quote');
      if (quote) {
        if (quote.dataset.id) jumpToMessage(quote.dataset.id);
        return;
      }
      const btn = e.target.closest('.msg-del');
      if (!btn) return;
      const node = btn.closest('.chat-msg');
      if (node) deleteMessage(node.dataset.id);
    });
    $('reply-bar-close').addEventListener('click', clearReply);
    // "Seen" only counts while the chat is actually in front of the user.
    document.addEventListener('visibilitychange', scheduleMarkRead);
    window.addEventListener('pageshow', scheduleMarkRead);
    document.addEventListener('click', scheduleMarkRead, true);
    document.addEventListener('touchstart', scheduleMarkRead, { capture: true, passive: true });
    setInterval(() => { if (document.visibilityState === 'visible') scheduleMarkRead(); }, 15000);
    window.addEventListener('focus', scheduleMarkRead);
    window.addEventListener('pagehide', stopTyping);
    $('copy-invite-btn').addEventListener('click', () => {
      if (!currentTeamData) return;
      navigator.clipboard?.writeText(currentTeamData.inviteCode).then(() => {
        const btn = $('copy-invite-btn');
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => { btn.innerHTML = original; }, 1200);
      });
    });
  }

  function promptSignIn() {
    $('no-auth-state').hidden = false;
    $('no-auth-state').scrollIntoView({ behavior: 'smooth' });
  }

  function init() {
    setupAuthForm();
    setupTabs();
    setupStaticButtons();
    lockAllDocSurfaces();          // read-only until a snapshot says otherwise
    const syncTopbar = () => {
      const tb = document.querySelector('.topbar');
      if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
    };
    syncTopbar();
    window.addEventListener('resize', syncTopbar);
    window.addEventListener('load', syncTopbar);
    document.addEventListener('lifeIsShortAuthState', () => setTimeout(syncTopbar, 0));
    const topbarEl = document.querySelector('.topbar');
    if (topbarEl && window.ResizeObserver) new ResizeObserver(syncTopbar).observe(topbarEl);
    // The notification bell asks us to open a team.
    document.addEventListener('teamNotifyOpenTeam', (e) => {
      const id = e.detail && e.detail.teamId;
      if (id && currentUser) selectTeam(id);
    });
    $('team-list').innerHTML = '<div class="empty-list">Loading your teams…</div>';
    let resolved = false;
    const resolve = (user) => { resolved = true; currentUser = user; renderAuthState(); };
    // Main path: auth.js announces the sign-in state.
    document.addEventListener('lifeIsShortAuthState', (event) => resolve(event.detail.user));
    // Backup path: read Firebase directly, in case the announcement was missed or is slow.
    let tries = 0;
    const poll = setInterval(() => {
      const auth = window.lifeIsShortAuth;
      if (auth) {
        clearInterval(poll);
        auth.onAuthStateChanged((user) => {
          if (!resolved || (user && !currentUser) || (!user && currentUser)) resolve(user);
        });
      } else if (++tries > 50) {
        clearInterval(poll);
        if (!resolved) {
          $('team-list').innerHTML = '<div class="empty-list">Sign-in is unavailable. Check your Firebase config.</div>';
          $('no-auth-state').hidden = false;
        }
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
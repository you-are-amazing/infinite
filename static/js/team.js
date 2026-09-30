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
  let messagesUnsub = null;
  let rewardsUnsub = null;
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
          if (!currentTeamId) { $('no-team-state').hidden = false; }
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

  async function leaveTeam() {
    if (!currentTeamId || !currentTeamData) return;
    if (!confirm(`Leave "${currentTeamData.name}"?`)) return;
    try {
      const ref = window.lifeIsShortDb.collection('teams').doc(currentTeamId);
      await ref.update({
        memberIds: firebase.firestore.FieldValue.arrayRemove(currentUser.uid),
        [`members.${currentUser.uid}`]: firebase.firestore.FieldValue.delete()
      });
      currentTeamId = null;
      window.infiniteActiveTeamId = null;
      teardownTeamListeners();
      setChatTitle('');
      clearReply();
      updateChatTools();
      $('team-content').hidden = true;
      $('no-team-state').hidden = false;
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
  }

  function selectTeam(teamId) {
    if (teamId === currentTeamId) return;
    teardownTeamListeners();
    currentTeamId = teamId;
    window.infiniteActiveTeamId = teamId;
    resetChatState();
    $('no-team-state').hidden = true;
    $('team-content').hidden = false;

    const db = window.lifeIsShortDb;
    const teamRef = db.collection('teams').doc(teamId);

    teamDocUnsub = teamRef.onSnapshot((doc) => {
      if (!doc.exists) {
        currentTeamId = null;
        window.infiniteActiveTeamId = null;
        setChatTitle('');
        $('team-content').hidden = true;
        $('no-team-state').hidden = false;
        return;
      }
      currentTeamData = doc.data();
      renderTeamHeader();
      renderMembers();
      refreshChat();
      Array.from(document.querySelectorAll('.team-item')).forEach((el) => el.classList.remove('active'));
    });

    goalsUnsub = teamRef.collection('goals').orderBy('createdAt', 'desc').onSnapshot((snap) => {
      renderGoals(snap.docs);
    }, (err) => console.warn('goals listener', err));

    messagesUnsub = teamRef.collection('messages').orderBy('createdAt', 'asc').limitToLast(50).onSnapshot((snap) => {
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
    Object.keys(members).forEach((uid) => {
      const el = document.createElement('div');
      el.className = 'avatar';
      el.title = members[uid].name || 'Member';
      el.textContent = initials(members[uid].name);
      avatarsEl.appendChild(el);
    });

    const listEl = $('members-list');
    listEl.innerHTML = '';
    Object.keys(members).forEach((uid) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      const isOwner = uid === currentTeamData.ownerId;
      row.innerHTML = `<span>${escapeHtml(members[uid].name || 'Member')}</span>${isOwner ? '<span class="owner-tag">OWNER</span>' : ''}`;
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

  function renderGoals(docs) {
    const list = $('goals-list');
    if (!docs.length) {
      list.innerHTML = '<div class="empty-hint">No goals yet. Add one above.</div>';
      return;
    }
    list.innerHTML = '';
    docs.forEach((doc) => {
      const goal = doc.data();
      const card = document.createElement('div');
      card.className = 'goal-card';

      if (goal.type === 'team') {
        const participants = goal.participants || {};
        const doneCount = Object.values(participants).filter((s) => s === 'done').length;
        const total = Object.keys(participants).length;
        const myStatus = participants[currentUser.uid] || 'pending';
        card.innerHTML = `
          <div class="goal-top">
            <div>
              <span class="badge badge-team">Team goal</span>
              <div class="goal-title">${escapeHtml(goal.title)}</div>
              <div class="goal-meta">${goalCadenceLabel(goal.cadence)} · ${doneCount}/${total} done</div>
            </div>
          </div>
          <div class="participants-grid" data-goal-id="${doc.id}">
            ${Object.keys(participants).map((uid) => {
              const name = (currentTeamData.members && currentTeamData.members[uid] && currentTeamData.members[uid].name) || 'Member';
              const done = participants[uid] === 'done';
              const isSelf = uid === currentUser.uid;
              return `<span class="participant-chip ${done ? 'done' : ''} ${isSelf ? 'self' : ''}" data-uid="${uid}" title="${done ? 'Done' : 'Pending'}"><span class="dot"></span>${escapeHtml(name)}</span>`;
            }).join('')}
          </div>`;
        card.querySelector('.participants-grid').addEventListener('click', (e) => {
          const chip = e.target.closest('.participant-chip.self');
          if (!chip) return;
          const newStatus = myStatus === 'done' ? 'pending' : 'done';
          doc.ref.update({ [`participants.${currentUser.uid}`]: newStatus });
        });
      } else {
        const isMine = goal.ownerId === currentUser.uid;
        const reactions = goal.reactions || {};
        const myReaction = reactions[currentUser.uid];
        const reactCount = Object.keys(reactions).length;
        card.innerHTML = `
          <div class="goal-top">
            <div>
              <span class="badge badge-self">${escapeHtml(goal.ownerName || 'Someone')}'s goal</span>
              <div class="goal-title">${escapeHtml(goal.title)}</div>
              <div class="goal-meta">${goalCadenceLabel(goal.cadence)}</div>
            </div>
            ${isMine ? `<button class="done-toggle ${goal.status === 'done' ? 'done' : ''}" data-goal-id="${doc.id}">${goal.status === 'done' ? '✓ Done' : 'Mark done'}</button>` : `<span class="done-toggle ${goal.status === 'done' ? 'done' : ''}" style="pointer-events:none;">${goal.status === 'done' ? '✓ Done' : 'Pending'}</span>`}
          </div>
          <div class="reactions-row">
            <button class="react-btn ${myReaction ? 'mine' : ''}" data-goal-id="${doc.id}">${REACT_EMOJI} ${reactCount || ''}</button>
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
      }
      list.appendChild(card);
    });
    const goalsCount = $('goals-count');
    if (goalsCount) goalsCount.textContent = docs.length;
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
    const mine = msg.senderId === currentUser.uid;
    const node = mk('div', 'chat-msg' + (mine ? ' mine' : ''));
    node.dataset.id = doc.id;

    if (!mine) node.appendChild(mk('div', 'sender', msg.senderName || 'Someone'));
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
    const mine = msg.senderId === currentUser.uid;
    node.querySelector('.time').textContent = formatTime(msg.createdAt);
    node.querySelector('.msg-del').hidden = !(mine || isOwner());

    const ticks = node.querySelector('.ticks');
    const label = node.querySelector('.seen-label');
    if (!mine) { ticks.hidden = true; label.hidden = true; return; }

    const ts = msg.createdAt && msg.createdAt.toMillis ? msg.createdAt.toMillis() : 0;
    const others = Object.keys((currentTeamData && currentTeamData.members) || {}).filter((u) => u !== currentUser.uid);
    const seen = ts ? others.filter((u) => (readsMap[u] || 0) >= ts) : [];
    const names = seen.map(memberName);

    let icon = 'fa-solid fa-check';
    let cls = 'ticks';
    let title = 'Sent';
    if (doc.metadata.hasPendingWrites) { icon = 'fa-regular fa-clock'; title = 'Sending…'; }
    else if (seen.length) {
      icon = 'fa-solid fa-check-double';
      title = 'Seen by ' + names.join(', ');
      if (seen.length === others.length) cls += ' seen';
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

  // ---------- Wiring ----------

  function setupTabs() {
    document.querySelectorAll('.team-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.team-tab').forEach((b) => b.classList.remove('active'));
        ['goals', 'rewards', 'members'].forEach((name) => {
          const panel = $('tab-' + name);
          if (panel) panel.hidden = name !== btn.dataset.tab;
        });
        btn.classList.add('active');
      });
    });
  }

  function setupStaticButtons() {
    $('create-team-btn').addEventListener('click', () => currentUser ? createTeam() : promptSignIn());
    $('join-team-btn').addEventListener('click', () => currentUser ? joinTeam() : promptSignIn());
    $('leave-team-btn').addEventListener('click', leaveTeam);
    $('add-goal-btn').addEventListener('click', addGoal);
    $('add-reward-btn').addEventListener('click', addReward);
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
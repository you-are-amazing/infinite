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
  let currentTeamData = null;
  let authMode = 'signin';

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
      teardownTeamListeners();
      setChatTitle('');
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
    if (teamDocUnsub) { teamDocUnsub(); teamDocUnsub = null; }
    if (goalsUnsub) { goalsUnsub(); goalsUnsub = null; }
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    if (rewardsUnsub) { rewardsUnsub(); rewardsUnsub = null; }
  }

  function selectTeam(teamId) {
    if (teamId === currentTeamId) return;
    currentTeamId = teamId;
    teardownTeamListeners();
    $('no-team-state').hidden = true;
    $('team-content').hidden = false;

    const db = window.lifeIsShortDb;
    const teamRef = db.collection('teams').doc(teamId);

    teamDocUnsub = teamRef.onSnapshot((doc) => {
      if (!doc.exists) {
        currentTeamId = null;
        setChatTitle('');
        $('team-content').hidden = true;
        $('no-team-state').hidden = false;
        return;
      }
      currentTeamData = doc.data();
      renderTeamHeader();
      renderMembers();
      Array.from(document.querySelectorAll('.team-item')).forEach((el) => el.classList.remove('active'));
    });

    goalsUnsub = teamRef.collection('goals').orderBy('createdAt', 'desc').onSnapshot((snap) => {
      renderGoals(snap.docs);
    }, (err) => console.warn('goals listener', err));

    messagesUnsub = teamRef.collection('messages').orderBy('createdAt', 'asc').limitToLast(50).onSnapshot((snap) => {
      renderMessages(snap.docs);
    }, (err) => console.warn('messages listener', err));

    rewardsUnsub = teamRef.collection('rewards').orderBy('createdAt', 'desc').onSnapshot((snap) => {
      renderRewards(snap.docs);
    }, (err) => console.warn('rewards listener', err));
  }

  function renderTeamHeader() {
    $('team-name').textContent = currentTeamData.name || 'Team';
    setChatTitle(currentTeamData.name || 'Team');
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

  function renderMessages(docs) {
    const wrap = $('chat-messages');
    wrap.innerHTML = '';
    docs.forEach((doc) => {
      const msg = doc.data();
      const el = document.createElement('div');
      el.className = 'chat-msg' + (msg.senderId === currentUser.uid ? ' mine' : '');
      el.innerHTML = `<div class="sender">${escapeHtml(msg.senderName || 'Someone')}</div>${escapeHtml(msg.text)}<div class="time">${formatTime(msg.createdAt)}</div>`;
      wrap.appendChild(el);
    });
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function sendMessage(event) {
    event.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !currentTeamId) return;
    input.value = '';
    await window.lifeIsShortDb.collection('teams').doc(currentTeamId).collection('messages').add({
      senderId: currentUser.uid,
      senderName: displayName(),
      text,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
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
// Room / game logic.
//
// Phases: lobby -> reveal -> discussion -> voting -> results -> (loop)
//
// State transitions are driven by Firebase transactions so any client
// can safely advance the room (no dependency on the host being online).

import {
  getDb,
  isConfigured,
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
} from './firebase.js';
import { pickRandomPair } from './words.js';

const el = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- Boot ----------

const params = new URLSearchParams(location.search);
const roomCode = (params.get('code') || sessionStorage.getItem('ws:roomCode') || '').toUpperCase();
const playerId = sessionStorage.getItem('ws:playerId');
const playerName = sessionStorage.getItem('ws:playerName');

if (!isConfigured) {
  fail('Firebase is not configured. See README.md.');
} else if (!roomCode || !playerId) {
  location.href = 'index.html';
}

el('room-code').textContent = roomCode;

const db = getDb();
const roomRef = ref(db, `rooms/${roomCode}`);
const myRef = ref(db, `rooms/${roomCode}/players/${playerId}`);

// Local mirror of the latest room snapshot, used by button handlers.
let currentRoom = null;
let timerInterval = null;
let lastView = null;
let hasFlipped = false;

// ---------- Clean up on leave ----------

// When this player closes the tab / loses connection, remove themselves
// from the players list. Best-effort — the game tolerates missing players.
(async () => {
  try {
    const snap = await get(myRef);
    if (!snap.exists()) {
      // They hit this page but never joined. Kick them back.
      location.href = 'index.html';
      return;
    }
    onDisconnect(myRef).remove();
  } catch (e) {
    console.warn('onDisconnect setup failed', e);
  }
})();

el('leave-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  await leaveRoom();
  location.href = 'index.html';
});

async function leaveRoom() {
  try {
    await remove(myRef);
    // If this player was the host, promote someone else OR delete the room if empty.
    if (currentRoom && currentRoom.host === playerId) {
      const snap = await get(ref(db, `rooms/${roomCode}/players`));
      const players = snap.val() || {};
      const remaining = Object.keys(players);
      if (remaining.length === 0) {
        await remove(roomRef);
      } else {
        // Promote the earliest-joined remaining player.
        remaining.sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));
        await update(roomRef, { host: remaining[0] });
      }
    }
  } catch (e) {
    console.warn('leaveRoom failed', e);
  }
  sessionStorage.removeItem('ws:roomCode');
  sessionStorage.removeItem('ws:playerId');
  sessionStorage.removeItem('ws:playerName');
  sessionStorage.removeItem('ws:isHost');
}

// ---------- Copy code ----------

el('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    const btn = el('copy-code');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1400);
  } catch {
    prompt('Room code:', roomCode);
  }
});

// ---------- Subscribe ----------

onValue(
  roomRef,
  (snap) => {
    const room = snap.val();
    if (!room) {
      // Room deleted — probably host left with nobody else.
      fail('The room was closed.');
      setTimeout(() => (location.href = 'index.html'), 1500);
      return;
    }
    // If I'm not in the players list any more, bounce home.
    if (!room.players || !room.players[playerId]) {
      sessionStorage.clear();
      location.href = 'index.html';
      return;
    }
    currentRoom = room;
    render(room);
    maybeAdvance(room);
  },
  (err) => {
    console.error(err);
    fail('Lost connection to the room.');
  }
);

function fail(msg) {
  const e = el('room-error');
  e.textContent = msg;
  e.hidden = false;
}

// ---------- Render ----------

function showView(name) {
  if (lastView === name) return;
  lastView = name;
  ['lobby', 'reveal', 'discussion', 'voting', 'results'].forEach((v) => {
    el(`view-${v}`).hidden = v !== name;
  });
  if (name !== 'reveal') hasFlipped = false;
}

function sortedPlayers(room) {
  return Object.entries(room.players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

function render(room) {
  const isHost = room.host === playerId;
  const players = sortedPlayers(room);
  el('round-badge').textContent = `Round ${Math.max(1, room.round || 1)}`;

  if (room.state === 'lobby') {
    showView('lobby');
    renderLobby(room, players, isHost);
  } else if (room.state === 'reveal') {
    showView('reveal');
    renderReveal(room, players);
  } else if (room.state === 'discussion') {
    showView('discussion');
    renderDiscussion(room, players, isHost);
  } else if (room.state === 'voting') {
    showView('voting');
    renderVoting(room, players);
  } else if (room.state === 'results') {
    showView('results');
    renderResults(room, players, isHost);
  }
}

// ---------- Lobby ----------

function renderLobby(room, players, isHost) {
  const ul = el('lobby-players');
  ul.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === room.host) li.classList.add('host');
    li.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span><span class="pscore">${p.score || 0}</span>`;
    ul.appendChild(li);
  });

  el('lobby-host-controls').hidden = !isHost;
  el('lobby-wait-msg').hidden = isHost;

  const startBtn = el('start-btn');
  const canStart = players.length >= 3 && players.length <= room.maxPlayers;
  startBtn.disabled = !canStart;
  startBtn.textContent =
    players.length < 3
      ? `Need ${3 - players.length} more player${3 - players.length === 1 ? '' : 's'}`
      : 'Start game';
}

el('start-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  if (currentRoom.host !== playerId) return;
  const btn = el('start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await startNewRound(1);
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    btn.textContent = 'Start game';
  }
});

async function startNewRound(roundNumber) {
  // Host-only action: pick a random word pair and a random spy, assign, move to reveal.
  const snap = await get(roomRef);
  const room = snap.val();
  if (!room) return;
  const players = sortedPlayers(room);
  if (players.length < 3) return;

  const pair = pickRandomPair();
  const spy = players[Math.floor(Math.random() * players.length)];

  const readyReset = {};
  players.forEach((p) => (readyReset[`players/${p.id}/ready`] = false));

  await update(roomRef, {
    state: 'reveal',
    round: roundNumber,
    game: {
      category: pair.category,
      civilianWord: pair.civilian,
      spyWord: pair.spy,
      spyId: spy.id,
      votes: null,
      discussionEndsAt: null,
      scored: false,
    },
    ...readyReset,
  });
}

// ---------- Reveal ----------

function renderReveal(room, players) {
  const me = room.players[playerId];
  const isSpy = room.game && room.game.spyId === playerId;
  const myWord = isSpy ? room.game.spyWord : room.game.civilianWord;

  el('reveal-word').textContent = myWord;
  const roleEl = el('reveal-role');
  roleEl.textContent = isSpy ? 'You are the SPY' : 'Civilian';
  roleEl.classList.toggle('spy', isSpy);

  const hintEl = el('reveal-hint');
  if (room.showHint && room.game.category) {
    hintEl.textContent = `Category: ${room.game.category}`;
    hintEl.hidden = false;
  } else {
    hintEl.hidden = true;
  }

  // Re-apply flip state in case of re-render.
  const card = el('reveal-card');
  if (hasFlipped) card.classList.add('flipped');
  else card.classList.remove('flipped');

  const readyBtn = el('ready-btn');
  readyBtn.disabled = me.ready || !hasFlipped;
  readyBtn.textContent = me.ready ? 'Waiting for others…' : "I'm ready";

  const readyCount = players.filter((p) => p.ready).length;
  el('ready-count').textContent = readyCount;
  el('ready-total').textContent = players.length;
}

el('reveal-card').addEventListener('click', () => {
  hasFlipped = true;
  el('reveal-card').classList.add('flipped');
  // Re-render the ready button state.
  if (currentRoom) renderReveal(currentRoom, sortedPlayers(currentRoom));
});

el('ready-btn').addEventListener('click', async () => {
  if (!hasFlipped) return;
  await update(myRef, { ready: true });
});

// ---------- Discussion ----------

function renderDiscussion(room, players, isHost) {
  // Speaking order = join order.
  const ol = el('turn-list');
  ol.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name;
    ol.appendChild(li);
  });

  el('disc-host-controls').hidden = !isHost;
  startTimerTick(room.game && room.game.discussionEndsAt);
}

function startTimerTick(endsAt) {
  stopTimerTick();
  const total = (currentRoom.timerSecs || 120) * 1000;
  const tick = () => {
    if (!endsAt) return;
    const remaining = Math.max(0, endsAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    el('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
    el('timer').classList.toggle('low', secs <= 10);
    el('timer-fill').style.width = `${Math.max(0, (remaining / total) * 100)}%`;
    if (remaining <= 0) {
      stopTimerTick();
      // Any client can try to advance to voting.
      tryAdvanceDiscussionToVoting();
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function stopTimerTick() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

el('vote-now-btn').addEventListener('click', async () => {
  await tryAdvanceDiscussionToVoting();
});

async function tryAdvanceDiscussionToVoting() {
  try {
    await runTransaction(roomRef, (room) => {
      if (!room) return;
      if (room.state !== 'discussion') return room;
      room.state = 'voting';
      return room;
    });
  } catch (e) {
    console.warn('advance to voting failed', e);
  }
}

// ---------- Voting ----------

function renderVoting(room, players) {
  stopTimerTick();
  const votes = (room.game && room.game.votes) || {};
  const myVote = votes[playerId];

  const ul = el('vote-list');
  ul.innerHTML = '';

  // Count votes to show tallies during voting.
  const tallies = {};
  Object.values(votes).forEach((t) => {
    tallies[t] = (tallies[t] || 0) + 1;
  });

  players.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === playerId) li.classList.add('self');
    if (myVote === p.id) li.classList.add('selected');
    li.innerHTML = `
      <span class="vname">${escapeHtml(p.name)}${p.id === playerId ? ' (you)' : ''}</span>
      <span class="vcount">${tallies[p.id] || 0}</span>`;
    li.addEventListener('click', () => castVote(p.id));
    ul.appendChild(li);
  });

  const votedCount = Object.keys(votes).length;
  el('voted-count').textContent = votedCount;
  el('voted-total').textContent = players.length;
}

async function castVote(targetId) {
  if (targetId === playerId) return;
  try {
    await update(ref(db, `rooms/${roomCode}/game/votes`), { [playerId]: targetId });
  } catch (e) {
    console.error(e);
  }
}

// ---------- Results ----------

function renderResults(room, players, isHost) {
  const game = room.game || {};
  const votes = game.votes || {};
  const tallies = {};
  Object.values(votes).forEach((t) => (tallies[t] = (tallies[t] || 0) + 1));

  // Whoever has the most votes is "accused". Tie = nobody caught.
  let maxVotes = 0;
  let topIds = [];
  for (const [id, n] of Object.entries(tallies)) {
    if (n > maxVotes) {
      maxVotes = n;
      topIds = [id];
    } else if (n === maxVotes) {
      topIds.push(id);
    }
  }
  const spyCaught = topIds.length === 1 && topIds[0] === game.spyId;

  const spyPlayer = players.find((p) => p.id === game.spyId);
  el('results-spy-name').textContent = spyPlayer ? spyPlayer.name : 'Unknown';
  el('results-spy-word').textContent = game.spyWord || '—';
  el('results-civ-word').textContent = game.civilianWord || '—';

  const outcome = el('results-outcome');
  if (spyCaught) {
    outcome.textContent = 'Civilians win — the spy was caught!';
    outcome.className = 'results-outcome caught';
  } else {
    outcome.textContent = 'The spy escaped!';
    outcome.className = 'results-outcome escaped';
  }

  const sb = el('scoreboard');
  sb.innerHTML = '';
  const sortedByScore = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topScore = sortedByScore[0] ? sortedByScore[0].score || 0 : 0;
  sortedByScore.forEach((p) => {
    const li = document.createElement('li');
    if ((p.score || 0) === topScore && topScore > 0) li.classList.add('top');
    li.innerHTML = `<span class="sname">${escapeHtml(p.name)}</span><span class="sscore">${p.score || 0}</span>`;
    sb.appendChild(li);
  });

  el('results-host-controls').hidden = !isHost;
}

el('next-round-btn').addEventListener('click', async () => {
  if (!currentRoom || currentRoom.host !== playerId) return;
  const btn = el('next-round-btn');
  btn.disabled = true;
  try {
    await startNewRound((currentRoom.round || 1) + 1);
  } finally {
    btn.disabled = false;
  }
});

el('back-lobby-btn').addEventListener('click', async () => {
  if (!currentRoom || currentRoom.host !== playerId) return;
  await update(roomRef, { state: 'lobby', game: null });
});

// ---------- State transition logic (any client can drive) ----------

async function maybeAdvance(room) {
  // If the host disconnected and is gone from the players list, any client
  // can promote the earliest-joined remaining player to host.
  if (room.host && room.players && !room.players[room.host]) {
    await runTransaction(roomRef, (r) => {
      if (!r || !r.players) return r;
      if (r.players[r.host]) return r;
      const ids = Object.keys(r.players);
      if (ids.length === 0) return null; // delete empty room
      ids.sort((a, b) => (r.players[a].joinedAt || 0) - (r.players[b].joinedAt || 0));
      r.host = ids[0];
      return r;
    });
  }

  // Reveal -> discussion when everyone is ready.
  if (room.state === 'reveal') {
    const players = Object.values(room.players || {});
    const allReady = players.length >= 3 && players.every((p) => p.ready);
    if (allReady) {
      await runTransaction(roomRef, (r) => {
        if (!r || r.state !== 'reveal') return r;
        const all = Object.values(r.players || {});
        if (all.length >= 3 && all.every((p) => p.ready)) {
          r.state = 'discussion';
          r.game = r.game || {};
          r.game.discussionEndsAt = Date.now() + (r.timerSecs || 120) * 1000;
        }
        return r;
      });
    }
  }

  // Discussion -> voting when timer expires (backup — the tick handler also does this).
  if (room.state === 'discussion' && room.game && room.game.discussionEndsAt) {
    if (Date.now() >= room.game.discussionEndsAt) {
      await tryAdvanceDiscussionToVoting();
    }
  }

  // Voting -> results when everyone has voted.
  if (room.state === 'voting') {
    const votes = (room.game && room.game.votes) || {};
    const playerIds = Object.keys(room.players || {});
    const allVoted = playerIds.length > 0 && playerIds.every((id) => votes[id]);
    if (allVoted) {
      await runTransaction(roomRef, (r) => {
        if (!r || r.state !== 'voting') return r;
        const v = (r.game && r.game.votes) || {};
        const ids = Object.keys(r.players || {});
        if (ids.length === 0 || !ids.every((id) => v[id])) return r;

        r.state = 'results';

        // Score the round exactly once.
        if (r.game && !r.game.scored) {
          const tallies = {};
          Object.values(v).forEach((t) => (tallies[t] = (tallies[t] || 0) + 1));
          let maxVotes = 0;
          let topIds = [];
          for (const [id, n] of Object.entries(tallies)) {
            if (n > maxVotes) { maxVotes = n; topIds = [id]; }
            else if (n === maxVotes) topIds.push(id);
          }
          const spyCaught = topIds.length === 1 && topIds[0] === r.game.spyId;

          if (spyCaught) {
            ids.forEach((id) => {
              if (id !== r.game.spyId) {
                r.players[id].score = (r.players[id].score || 0) + 1;
              }
            });
          } else if (r.players[r.game.spyId]) {
            r.players[r.game.spyId].score = (r.players[r.game.spyId].score || 0) + 2;
          }
          r.game.scored = true;
        }
        return r;
      });
    }
  }
}

// ---------- Utilities ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// If the tab becomes visible again, re-run maybeAdvance for the latest room.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentRoom) maybeAdvance(currentRoom);
});

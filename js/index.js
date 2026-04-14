// Landing page — create / join a room.

import {
  getDb,
  isConfigured,
  ref,
  set,
  get,
  serverTimestamp,
} from './firebase.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/I/1

const el = (id) => document.getElementById(id);

// ---------- UI: tab switching ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active);
    });
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    hideError();
  });
});

// ---------- Live labels for range sliders ----------

const sizeInput = el('create-size');
const sizeLabel = el('size-label');
sizeInput.addEventListener('input', () => {
  sizeLabel.textContent = sizeInput.value;
});

const timerInput = el('create-timer');
const timerLabel = el('timer-label');
const formatTime = (secs) => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};
timerInput.addEventListener('input', () => {
  timerLabel.textContent = formatTime(+timerInput.value);
});

// ---------- Join code: force uppercase ----------

const joinCodeInput = el('join-code');
joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ---------- Helpers ----------

function showError(msg) {
  const e = el('landing-error');
  e.textContent = msg;
  e.hidden = false;
}
function hideError() {
  el('landing-error').hidden = true;
}

function generateCode(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function savePlayer(roomCode, playerId, name, isHost) {
  sessionStorage.setItem('ws:roomCode', roomCode);
  sessionStorage.setItem('ws:playerId', playerId);
  sessionStorage.setItem('ws:playerName', name);
  sessionStorage.setItem('ws:isHost', isHost ? '1' : '0');
}

// ---------- Create room ----------

el('create-panel').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  if (!isConfigured) {
    showError('Firebase is not configured yet. See README.md — it takes ~2 minutes.');
    return;
  }

  const name = el('create-name').value.trim();
  const maxPlayers = parseInt(sizeInput.value, 10);
  const timerSecs = parseInt(timerInput.value, 10);
  const showHint = el('create-hints').checked;

  if (!name) return showError('Please enter your name.');
  if (name.length > 16) return showError('Name is too long.');

  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const db = getDb();
    let code, attempts = 0;
    while (true) {
      code = generateCode(4);
      const snap = await get(ref(db, `rooms/${code}`));
      if (!snap.exists()) break;
      if (++attempts > 10) throw new Error('Could not generate a unique code. Try again.');
    }

    const playerId = generatePlayerId();
    const roomData = {
      host: playerId,
      maxPlayers,
      timerSecs,
      showHint,
      state: 'lobby',
      round: 0,
      createdAt: serverTimestamp(),
      players: {
        [playerId]: {
          name,
          score: 0,
          ready: false,
          joinedAt: serverTimestamp(),
        },
      },
    };

    await set(ref(db, `rooms/${code}`), roomData);
    savePlayer(code, playerId, name, true);
    window.location.href = `room.html?code=${code}`;
  } catch (err) {
    console.error(err);
    showError(err.message || 'Failed to create room.');
    btn.disabled = false;
    btn.textContent = 'Create room';
  }
});

// ---------- Join room ----------

el('join-panel').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  if (!isConfigured) {
    showError('Firebase is not configured yet. See README.md — it takes ~2 minutes.');
    return;
  }

  const name = el('join-name').value.trim();
  const code = el('join-code').value.trim().toUpperCase();

  if (!name) return showError('Please enter your name.');
  if (!code || code.length !== 4) return showError('Enter the 4-character room code.');

  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Joining…';

  try {
    const db = getDb();
    const roomSnap = await get(ref(db, `rooms/${code}`));
    if (!roomSnap.exists()) throw new Error('Room not found. Check the code.');

    const room = roomSnap.val();
    if (room.state !== 'lobby') throw new Error('Game already in progress.');

    const playerCount = room.players ? Object.keys(room.players).length : 0;
    if (playerCount >= room.maxPlayers) throw new Error('Room is full.');

    const nameTaken = room.players && Object.values(room.players).some(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    );
    if (nameTaken) throw new Error('That name is taken in this room.');

    const playerId = generatePlayerId();
    await set(ref(db, `rooms/${code}/players/${playerId}`), {
      name,
      score: 0,
      ready: false,
      joinedAt: serverTimestamp(),
    });

    savePlayer(code, playerId, name, false);
    window.location.href = `room.html?code=${code}`;
  } catch (err) {
    console.error(err);
    showError(err.message || 'Failed to join room.');
    btn.disabled = false;
    btn.textContent = 'Join room';
  }
});

// ---------- URL prefill for ?code= ----------

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  joinCodeInput.value = urlCode.toUpperCase();
  document.querySelector('.tab[data-tab="join"]').click();
}

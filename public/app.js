let eventSource = null;
let currentJobId = null;

function log(msg, level = 'info') {
  const pane = document.getElementById('debug-pane');
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  line.textContent = `[${time}] ${msg}`;
  pane.appendChild(line);
  pane.scrollTop = pane.scrollHeight;
}

function clearLog() {
  document.getElementById('debug-pane').innerHTML = '';
  log('Log cleared.');
}

function setRunning(running) {
  document.getElementById('btn-start').disabled = running;
  document.getElementById('btn-stop').disabled = !running;
  document.getElementById('dest').disabled = running;
  document.getElementById('amount').disabled = running;
  document.getElementById('speed').disabled = running;
}

function updateProgress(data) {
  const card = document.getElementById('progress-card');
  card.style.display = 'block';

  const pct = data.total > 0 ? ((data.completed + data.failed) / data.total * 100) : 0;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('p-sent').textContent = data.sent.toLocaleString();
  document.getElementById('p-completed').textContent = data.completed;
  document.getElementById('p-failed').textContent = data.failed;
  document.getElementById('p-total').textContent = data.total;
}

function startFunding() {
  const dest = document.getElementById('dest').value.trim();
  const amount = document.getElementById('amount').value;
  const speed = document.getElementById('speed').value;

  if (!dest || !dest.startsWith('G') || dest.length !== 56) {
    log('Invalid Stellar address. Must start with G and be 56 characters.', 'error');
    return;
  }

  setRunning(true);
  updateProgress({ completed: 0, failed: 0, total: 0, sent: 0 });
  log(`Starting funding: ${parseInt(amount).toLocaleString()} XLM to ${dest.slice(0, 8)}...${dest.slice(-8)}`);

  const params = new URLSearchParams({ dest, amount, speed });
  eventSource = new EventSource(`/api/fund?${params}`);

  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    switch (data.type) {
      case 'job':
        currentJobId = data.jobId;
        break;
      case 'log':
        log(data.msg, data.level);
        break;
      case 'progress':
        updateProgress(data);
        break;
      case 'error':
        log(data.msg, 'error');
        break;
      case 'done':
        log(`Done! Total sent: ${data.total.toLocaleString()} XLM`, 'success');
        cleanup();
        break;
    }
  };

  eventSource.onerror = () => {
    log('Connection lost.', 'error');
    cleanup();
  };
}

function stopFunding() {
  if (!currentJobId) return;
  log('Stopping...', 'warn');

  fetch('/api/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: currentJobId })
  }).catch(() => {});
}

function cleanup() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  currentJobId = null;
  setRunning(false);
}

async function checkBalance() {
  const dest = document.getElementById('dest').value.trim();
  const el = document.getElementById('balance-result');

  if (!dest || !dest.startsWith('G') || dest.length !== 56) {
    el.style.color = 'var(--red)';
    el.textContent = 'Enter a valid address first';
    return;
  }

  el.style.color = 'var(--text-dim)';
  el.textContent = 'Checking...';

  try {
    const res = await fetch(`/api/balance?address=${dest}`);
    const data = await res.json();

    if (data.exists) {
      el.style.color = 'var(--gold)';
      el.textContent = `Balance: ${parseFloat(data.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} XLM`;
      log(`Balance check: ${data.balance.toLocaleString()} XLM`, 'info');
    } else {
      el.style.color = 'var(--orange)';
      el.textContent = 'Account does not exist yet (will be created on first fund)';
      log('Balance check: account does not exist', 'warn');
    }
  } catch (e) {
    el.style.color = 'var(--red)';
    el.textContent = 'Failed to check balance';
    log(`Balance check failed: ${e.message}`, 'error');
  }
}

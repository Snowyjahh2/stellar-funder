const express = require('express');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const SEND_PER_ACCOUNT = 9900;

// Track active jobs so we can stop them
const jobs = {};

// ---- SSE: stream logs to client ----
function setupSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  return send;
}

// ---- Friendbot: fund a temp account ----
async function fundViaFriendbot(publicKey, send, tag) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const url = `${FRIENDBOT_URL}?addr=${publicKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        send('log', { msg: `${tag} Funded temp account`, level: 'success' });
        return true;
      }

      const wait = Math.min(2 * attempt, 15);
      send('log', { msg: `${tag} Friendbot busy (attempt ${attempt}/10), waiting ${wait}s...`, level: 'warn' });
      await sleep(wait * 1000);
    } catch (e) {
      const wait = Math.min(2 * attempt, 15);
      send('log', { msg: `${tag} Friendbot timeout (attempt ${attempt}/10), waiting ${wait}s...`, level: 'warn' });
      await sleep(wait * 1000);
    }
  }
  return false;
}

// ---- Send XLM from temp to destination ----
async function sendXLM(tempKeypair, dest, isCreate) {
  const server = new StellarSdk.Horizon.Server(HORIZON_URL);
  const source = await server.loadAccount(tempKeypair.publicKey());

  const builder = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET
  });

  if (isCreate) {
    builder.addOperation(StellarSdk.Operation.createAccount({
      destination: dest,
      startingBalance: SEND_PER_ACCOUNT.toString()
    }));
  } else {
    builder.addOperation(StellarSdk.Operation.payment({
      destination: dest,
      asset: StellarSdk.Asset.native(),
      amount: SEND_PER_ACCOUNT.toString()
    }));
  }

  const tx = builder.setTimeout(30).build();
  tx.sign(tempKeypair);
  const resp = await server.submitTransaction(tx);
  return resp.hash;
}

// ---- Check if account exists ----
async function accountExists(address) {
  try {
    const server = new StellarSdk.Horizon.Server(HORIZON_URL);
    await server.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Process a single account (fund + send) ----
async function processAccount(idx, total, dest, isCreate, send, job) {
  const tag = `[${idx}/${total}]`;
  send('log', { msg: `${tag} Funding temp account...`, level: 'info' });

  const temp = StellarSdk.Keypair.random();
  const funded = await fundViaFriendbot(temp.publicKey(), send, tag);

  if (!funded) {
    send('log', { msg: `${tag} FAILED — could not fund temp account`, level: 'error' });
    return { sent: 0, ok: false };
  }

  await sleep(1000); // Wait for ledger close

  try {
    const hash = await sendXLM(temp, dest, isCreate);
    send('log', { msg: `${tag} Sent ${SEND_PER_ACCOUNT.toLocaleString()} XLM — TX: ${hash.slice(0, 16)}...`, level: 'success' });
    return { sent: SEND_PER_ACCOUNT, ok: true };
  } catch (e) {
    send('log', { msg: `${tag} Send failed: ${e.message}`, level: 'error' });
    return { sent: 0, ok: false };
  }
}

// ---- Main funding endpoint (SSE stream) ----
app.get('/api/fund', async (req, res) => {
  const { dest, amount, speed } = req.query;
  const send = setupSSE(res);

  // Validate
  if (!dest || !dest.startsWith('G') || dest.length !== 56) {
    send('error', { msg: 'Invalid Stellar address' });
    send('done', { total: 0 });
    return res.end();
  }

  const totalXLM = parseInt(amount) || 50000;
  const concurrency = Math.min(20, Math.max(1, Math.round(parseFloat(speed) || 5)));
  const numAccounts = Math.ceil(totalXLM / SEND_PER_ACCOUNT);

  const jobId = Date.now().toString();
  jobs[jobId] = { running: true };
  send('job', { jobId });

  send('log', { msg: `Starting: ~${totalXLM.toLocaleString()} XLM via ${numAccounts} accounts`, level: 'info' });
  send('log', { msg: `Destination: ${dest.slice(0, 8)}...${dest.slice(-8)}`, level: 'info' });
  send('log', { msg: `Concurrency: ${concurrency} workers`, level: 'info' });

  let sentTotal = 0;
  let completed = 0;
  let failed = 0;

  // Check if dest exists — if not, create it with the first account before launching workers
  let startIdx = 1;
  try {
    const exists = await accountExists(dest);
    if (!exists) {
      send('log', { msg: 'Destination not funded yet, creating it first...', level: 'warn' });
      const result = await processAccount(1, numAccounts, dest, true, send, jobs[jobId]);
      if (result.ok) {
        sentTotal += result.sent;
        completed++;
      } else {
        failed++;
      }
      send('progress', { completed, failed, total: numAccounts, sent: sentTotal });
      startIdx = 2;
    } else {
      send('log', { msg: 'Destination account exists', level: 'success' });
    }
  } catch (e) {
    send('log', { msg: `Error checking destination: ${e.message}`, level: 'error' });
  }

  // Concurrent worker pool
  if (startIdx <= numAccounts && jobs[jobId]?.running) {
    let nextIdx = startIdx;

    async function worker() {
      while (jobs[jobId]?.running) {
        const idx = nextIdx++;
        if (idx > numAccounts) break;

        const result = await processAccount(idx, numAccounts, dest, false, send, jobs[jobId]);
        if (result.ok) {
          sentTotal += result.sent;
          completed++;
        } else {
          failed++;
        }
        send('progress', { completed, failed, total: numAccounts, sent: sentTotal });
      }
    }

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  if (!jobs[jobId]?.running) {
    send('log', { msg: 'Stopped by user', level: 'warn' });
  }

  send('log', { msg: `Finished! Sent ${sentTotal.toLocaleString()} XLM total`, level: 'info' });
  send('done', { total: sentTotal });
  delete jobs[jobId];
  res.end();
});

// ---- Stop a running job ----
app.post('/api/stop', (req, res) => {
  const { jobId } = req.body;
  if (jobs[jobId]) {
    jobs[jobId].running = false;
    res.json({ stopped: true });
  } else {
    res.json({ stopped: false, error: 'Job not found or already finished' });
  }
});

// ---- Check destination balance ----
app.get('/api/balance', async (req, res) => {
  const { address } = req.query;
  try {
    const server = new StellarSdk.Horizon.Server(HORIZON_URL);
    const account = await server.loadAccount(address);
    const xlm = account.balances.find(b => b.asset_type === 'native');
    res.json({ balance: xlm ? parseFloat(xlm.balance) : 0, exists: true });
  } catch {
    res.json({ balance: 0, exists: false });
  }
});

app.listen(PORT, () => {
  console.log(`Funder running on http://localhost:${PORT}`);
});

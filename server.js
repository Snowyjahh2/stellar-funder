const express = require('express');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

function getServer() {
  return new StellarSdk.Horizon.Server(HORIZON_URL);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Generate keypair
// ============================================================
app.post('/api/keypair', (req, res) => {
  const kp = StellarSdk.Keypair.random();
  res.json({ public: kp.publicKey(), secret: kp.secret() });
});

// ============================================================
// Fund account via Friendbot
// ============================================================
app.post('/api/fund', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const r = await fetch(`${FRIENDBOT_URL}?addr=${address}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (r.ok) {
      res.json({ success: true, message: 'Account funded with 10,000 XLM' });
    } else {
      const body = await r.text();
      res.status(400).json({ error: `Friendbot error: ${body.slice(0, 200)}` });
    }
  } catch (e) {
    res.status(500).json({ error: `Friendbot failed: ${e.message}` });
  }
});

// ============================================================
// Get account info (balances, trustlines)
// ============================================================
app.get('/api/account', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    const server = getServer();
    const account = await server.loadAccount(address);
    res.json({
      exists: true,
      balances: account.balances.map(b => ({
        asset: b.asset_type === 'native' ? 'XLM' : `${b.asset_code}:${b.asset_issuer}`,
        assetCode: b.asset_type === 'native' ? 'XLM' : b.asset_code,
        assetIssuer: b.asset_issuer || null,
        balance: b.balance,
        limit: b.limit || null
      }))
    });
  } catch {
    res.json({ exists: false, balances: [] });
  }
});

// ============================================================
// Create trustline (distributor trusts issuer's asset)
// ============================================================
app.post('/api/trustline', async (req, res) => {
  const { distributorSecret, assetCode, issuerPublic, limit } = req.body;

  if (!distributorSecret || !assetCode || !issuerPublic) {
    return res.status(400).json({ error: 'distributorSecret, assetCode, issuerPublic required' });
  }

  try {
    const server = getServer();
    const distributor = StellarSdk.Keypair.fromSecret(distributorSecret);
    const account = await server.loadAccount(distributor.publicKey());
    const asset = new StellarSdk.Asset(assetCode, issuerPublic);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET
    })
      .addOperation(StellarSdk.Operation.changeTrust({
        asset,
        limit: limit || undefined
      }))
      .setTimeout(30)
      .build();

    tx.sign(distributor);
    const result = await server.submitTransaction(tx);
    res.json({ success: true, hash: result.hash });
  } catch (e) {
    const msg = e.response?.data?.extras?.result_codes
      ? JSON.stringify(e.response.data.extras.result_codes)
      : e.message;
    res.status(500).json({ error: `Trustline failed: ${msg}` });
  }
});

// ============================================================
// Issue (mint) tokens — issuer sends to distributor
// ============================================================
app.post('/api/issue', async (req, res) => {
  const { issuerSecret, distributorPublic, assetCode, amount } = req.body;

  if (!issuerSecret || !distributorPublic || !assetCode || !amount) {
    return res.status(400).json({ error: 'issuerSecret, distributorPublic, assetCode, amount required' });
  }

  try {
    const server = getServer();
    const issuer = StellarSdk.Keypair.fromSecret(issuerSecret);
    const account = await server.loadAccount(issuer.publicKey());
    const asset = new StellarSdk.Asset(assetCode, issuer.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET
    })
      .addOperation(StellarSdk.Operation.payment({
        destination: distributorPublic,
        asset,
        amount: amount.toString()
      }))
      .setTimeout(30)
      .build();

    tx.sign(issuer);
    const result = await server.submitTransaction(tx);
    res.json({ success: true, hash: result.hash });
  } catch (e) {
    const msg = e.response?.data?.extras?.result_codes
      ? JSON.stringify(e.response.data.extras.result_codes)
      : e.message;
    res.status(500).json({ error: `Issue failed: ${msg}` });
  }
});

// ============================================================
// Send tokens from any account to another
// ============================================================
app.post('/api/send', async (req, res) => {
  const { senderSecret, destination, assetCode, issuerPublic, amount } = req.body;

  if (!senderSecret || !destination || !amount) {
    return res.status(400).json({ error: 'senderSecret, destination, amount required' });
  }

  try {
    const server = getServer();
    const sender = StellarSdk.Keypair.fromSecret(senderSecret);
    const account = await server.loadAccount(sender.publicKey());

    // XLM or custom asset
    const asset = (!assetCode || assetCode === 'XLM')
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(assetCode, issuerPublic);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET
    })
      .addOperation(StellarSdk.Operation.payment({
        destination,
        asset,
        amount: amount.toString()
      }))
      .setTimeout(30)
      .build();

    tx.sign(sender);
    const result = await server.submitTransaction(tx);
    res.json({ success: true, hash: result.hash });
  } catch (e) {
    const msg = e.response?.data?.extras?.result_codes
      ? JSON.stringify(e.response.data.extras.result_codes)
      : e.message;
    res.status(500).json({ error: `Send failed: ${msg}` });
  }
});

// ============================================================
// Lock issuer (set all weights to 0 — irreversible, caps supply)
// ============================================================
app.post('/api/lock-issuer', async (req, res) => {
  const { issuerSecret } = req.body;
  if (!issuerSecret) return res.status(400).json({ error: 'issuerSecret required' });

  try {
    const server = getServer();
    const issuer = StellarSdk.Keypair.fromSecret(issuerSecret);
    const account = await server.loadAccount(issuer.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET
    })
      .addOperation(StellarSdk.Operation.setOptions({
        masterWeight: 0,
        lowThreshold: 0,
        medThreshold: 0,
        highThreshold: 0
      }))
      .setTimeout(30)
      .build();

    tx.sign(issuer);
    const result = await server.submitTransaction(tx);
    res.json({ success: true, hash: result.hash, message: 'Issuer locked. No more tokens can be minted.' });
  } catch (e) {
    const msg = e.response?.data?.extras?.result_codes
      ? JSON.stringify(e.response.data.extras.result_codes)
      : e.message;
    res.status(500).json({ error: `Lock failed: ${msg}` });
  }
});

// ============================================================
// Set home domain and TOML metadata for the asset
// ============================================================
app.post('/api/set-domain', async (req, res) => {
  const { issuerSecret, domain } = req.body;
  if (!issuerSecret || !domain) return res.status(400).json({ error: 'issuerSecret and domain required' });

  try {
    const server = getServer();
    const issuer = StellarSdk.Keypair.fromSecret(issuerSecret);
    const account = await server.loadAccount(issuer.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET
    })
      .addOperation(StellarSdk.Operation.setOptions({
        homeDomain: domain
      }))
      .setTimeout(30)
      .build();

    tx.sign(issuer);
    const result = await server.submitTransaction(tx);
    res.json({ success: true, hash: result.hash });
  } catch (e) {
    res.status(500).json({ error: `Set domain failed: ${e.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Token Creator running on http://localhost:${PORT}`);
});

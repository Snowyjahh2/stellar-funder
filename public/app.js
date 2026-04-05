// ============================================================
// Helpers
// ============================================================
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

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

function setStatus(id, msg, type = '') {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status ${type}`;
}

function toggleSecret(inputId) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}

function getConfig() {
  return {
    assetCode: document.getElementById('asset-code').value.trim().toUpperCase(),
    totalSupply: document.getElementById('total-supply').value,
    issuerPublic: document.getElementById('issuer-public').value.trim(),
    issuerSecret: document.getElementById('issuer-secret').value.trim(),
    distPublic: document.getElementById('dist-public').value.trim(),
    distSecret: document.getElementById('dist-secret').value.trim()
  };
}

// ============================================================
// Generate keypair
// ============================================================
async function generateKeypair(type) {
  const statusId = `${type}-status`;
  try {
    setStatus(statusId, 'Generating...', '');
    const data = await api('POST', '/api/keypair');
    document.getElementById(`${type}-public`).value = data.public;
    document.getElementById(`${type}-secret`).value = data.secret;
    setStatus(statusId, `New keypair generated`, 'success');
    log(`${type === 'issuer' ? 'Issuer' : 'Distributor'} keypair generated: ${data.public.slice(0, 8)}...`, 'success');
    autoSave();
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Generate failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Fund account via Friendbot
// ============================================================
async function fundAccount(type) {
  const statusId = `${type}-status`;
  const address = document.getElementById(`${type}-public`).value.trim();

  if (!address) {
    setStatus(statusId, 'Generate a keypair first', 'error');
    return;
  }

  try {
    setStatus(statusId, 'Funding via Friendbot...', '');
    log(`Funding ${type} account via Friendbot...`);
    const data = await api('POST', '/api/fund', { address });
    setStatus(statusId, 'Funded with 10,000 XLM', 'success');
    log(`${type === 'issuer' ? 'Issuer' : 'Distributor'} funded: ${address.slice(0, 8)}...`, 'success');
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Fund failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Check account balance
// ============================================================
async function checkAccount(type) {
  const statusId = `${type}-status`;
  const address = document.getElementById(`${type}-public`).value.trim();

  if (!address) {
    setStatus(statusId, 'No address to check', 'error');
    return;
  }

  try {
    setStatus(statusId, 'Checking...', '');
    const data = await api('GET', `/api/account?address=${address}`);

    if (!data.exists) {
      setStatus(statusId, 'Account does not exist — fund it first', 'error');
      log(`${type} account not found`, 'warn');
      return;
    }

    const lines = data.balances.map(b => `${b.assetCode}: ${parseFloat(b.balance).toLocaleString()}`);
    setStatus(statusId, lines.join(' | '), 'success');
    log(`${type === 'issuer' ? 'Issuer' : 'Distributor'} balances: ${lines.join(', ')}`, 'info');
  } catch (e) {
    setStatus(statusId, e.message, 'error');
  }
}

// ============================================================
// Create token (trustline + issue)
// ============================================================
async function createToken() {
  const config = getConfig();
  const statusId = 'create-status';

  if (!config.assetCode) { setStatus(statusId, 'Enter an asset code', 'error'); return; }
  if (config.assetCode.length > 12) { setStatus(statusId, 'Asset code max 12 characters', 'error'); return; }
  if (!config.issuerSecret) { setStatus(statusId, 'Issuer secret key required', 'error'); return; }
  if (!config.distSecret) { setStatus(statusId, 'Distributor secret key required', 'error'); return; }
  if (!config.issuerPublic) { setStatus(statusId, 'Issuer public key required', 'error'); return; }
  if (!config.distPublic) { setStatus(statusId, 'Distributor public key required', 'error'); return; }
  if (!config.totalSupply || parseFloat(config.totalSupply) <= 0) { setStatus(statusId, 'Enter a supply', 'error'); return; }

  try {
    // Step 1: Create trustline
    setStatus(statusId, 'Step 1/2: Creating trustline...', '');
    log(`Creating trustline: ${config.distPublic.slice(0, 8)}... trusts ${config.assetCode} from ${config.issuerPublic.slice(0, 8)}...`);

    await api('POST', '/api/trustline', {
      distributorSecret: config.distSecret,
      assetCode: config.assetCode,
      issuerPublic: config.issuerPublic
    });
    log('Trustline created', 'success');

    // Step 2: Issue tokens
    setStatus(statusId, 'Step 2/2: Minting tokens...', '');
    log(`Minting ${parseFloat(config.totalSupply).toLocaleString()} ${config.assetCode}...`);

    await api('POST', '/api/issue', {
      issuerSecret: config.issuerSecret,
      distributorPublic: config.distPublic,
      assetCode: config.assetCode,
      amount: config.totalSupply
    });

    setStatus(statusId, `${parseFloat(config.totalSupply).toLocaleString()} ${config.assetCode} minted!`, 'success');
    log(`TOKEN CREATED: ${parseFloat(config.totalSupply).toLocaleString()} ${config.assetCode}`, 'success');
    autoSave();
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Create failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Send tokens
// ============================================================
async function sendTokens() {
  const senderSecret = document.getElementById('send-from').value.trim();
  const destination = document.getElementById('send-to').value.trim();
  const assetType = document.getElementById('send-asset').value;
  const amount = document.getElementById('send-amount').value;
  const statusId = 'send-status';
  const config = getConfig();

  if (!senderSecret) { setStatus(statusId, 'Enter sender secret key', 'error'); return; }
  if (!destination) { setStatus(statusId, 'Enter destination address', 'error'); return; }
  if (!amount || parseFloat(amount) <= 0) { setStatus(statusId, 'Enter an amount', 'error'); return; }

  const isXLM = assetType === 'XLM';
  const label = isXLM ? 'XLM' : config.assetCode;

  if (!isXLM && !config.assetCode) { setStatus(statusId, 'Set asset code in Token Config first', 'error'); return; }
  if (!isXLM && !config.issuerPublic) { setStatus(statusId, 'Set issuer public key first', 'error'); return; }

  try {
    setStatus(statusId, 'Sending...', '');
    log(`Sending ${parseFloat(amount).toLocaleString()} ${label} to ${destination.slice(0, 8)}...`);

    const body = {
      senderSecret,
      destination,
      amount
    };
    if (!isXLM) {
      body.assetCode = config.assetCode;
      body.issuerPublic = config.issuerPublic;
    } else {
      body.assetCode = 'XLM';
    }

    const data = await api('POST', '/api/send', body);
    setStatus(statusId, `Sent! TX: ${data.hash.slice(0, 16)}...`, 'success');
    log(`Sent ${parseFloat(amount).toLocaleString()} ${label} — TX: ${data.hash.slice(0, 16)}...`, 'success');
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Send failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Advanced: Set domain
// ============================================================
async function setDomain() {
  const domain = document.getElementById('home-domain').value.trim();
  const config = getConfig();
  const statusId = 'domain-status';

  if (!domain) { setStatus(statusId, 'Enter a domain', 'error'); return; }
  if (!config.issuerSecret) { setStatus(statusId, 'Issuer secret key required', 'error'); return; }

  try {
    setStatus(statusId, 'Setting domain...', '');
    log(`Setting home domain to ${domain}...`);
    await api('POST', '/api/set-domain', { issuerSecret: config.issuerSecret, domain });
    setStatus(statusId, `Home domain set to ${domain}`, 'success');
    log(`Home domain set: ${domain}`, 'success');
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Set domain failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Advanced: Lock issuer
// ============================================================
async function lockIssuer() {
  const config = getConfig();
  const statusId = 'lock-status';

  if (!config.issuerSecret) { setStatus(statusId, 'Issuer secret key required', 'error'); return; }

  if (!confirm('WARNING: This will permanently lock the issuer account.\n\nNo more tokens can EVER be minted.\n\nAre you absolutely sure?')) return;
  if (!confirm('FINAL WARNING: This is IRREVERSIBLE. Continue?')) return;

  try {
    setStatus(statusId, 'Locking issuer...', '');
    log('Locking issuer account (irreversible)...', 'warn');
    await api('POST', '/api/lock-issuer', { issuerSecret: config.issuerSecret });
    setStatus(statusId, 'Issuer locked permanently. Supply is capped.', 'success');
    log('ISSUER LOCKED — no more tokens can be minted', 'success');
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Lock failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Advanced: Manual trustline
// ============================================================
async function manualTrustline() {
  const secret = document.getElementById('trust-secret').value.trim();
  const config = getConfig();
  const statusId = 'trust-status';

  if (!secret) { setStatus(statusId, 'Enter account secret key', 'error'); return; }
  if (!config.assetCode) { setStatus(statusId, 'Set asset code first', 'error'); return; }
  if (!config.issuerPublic) { setStatus(statusId, 'Set issuer public key first', 'error'); return; }

  try {
    setStatus(statusId, 'Creating trustline...', '');
    log(`Creating trustline for ${config.assetCode}...`);
    await api('POST', '/api/trustline', {
      distributorSecret: secret,
      assetCode: config.assetCode,
      issuerPublic: config.issuerPublic
    });
    setStatus(statusId, 'Trustline created', 'success');
    log('Trustline created', 'success');
  } catch (e) {
    setStatus(statusId, e.message, 'error');
    log(`Trustline failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Save / Load / Export config
// ============================================================
function autoSave() {
  const config = getConfig();
  localStorage.setItem('stellar-token-config', JSON.stringify(config));
}

function saveConfig() {
  autoSave();
  setStatus('save-status', 'Saved to browser', 'success');
  log('Config saved to localStorage', 'info');
}

function loadConfig() {
  try {
    const raw = localStorage.getItem('stellar-token-config');
    if (!raw) return;
    const config = JSON.parse(raw);
    if (config.assetCode) document.getElementById('asset-code').value = config.assetCode;
    if (config.totalSupply) document.getElementById('total-supply').value = config.totalSupply;
    if (config.issuerPublic) document.getElementById('issuer-public').value = config.issuerPublic;
    if (config.issuerSecret) document.getElementById('issuer-secret').value = config.issuerSecret;
    if (config.distPublic) document.getElementById('dist-public').value = config.distPublic;
    if (config.distSecret) document.getElementById('dist-secret').value = config.distSecret;
    log('Loaded saved config from browser', 'info');
  } catch { /* ignore */ }
}

function clearConfig() {
  if (!confirm('Clear all saved keys and config from browser?')) return;
  localStorage.removeItem('stellar-token-config');
  setStatus('save-status', 'Cleared', 'success');
  log('Saved config cleared', 'warn');
}

function exportConfig() {
  const config = getConfig();
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.assetCode || 'token'}-config.json`;
  a.click();
  URL.revokeObjectURL(url);
  log('Config exported as JSON', 'info');
}

// Boot
loadConfig();

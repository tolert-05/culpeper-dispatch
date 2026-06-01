require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cors     = require('cors');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer');
const https    = require('https');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database(path.join(__dirname, 'dispatch.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id          TEXT PRIMARY KEY,
    type        TEXT,
    address     TEXT,
    status      TEXT,
    raw         TEXT,
    first_seen  TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen   TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Use local Chrome if available (Mac dev), otherwise fall back to puppeteer's bundled Chromium (cloud)
const CHROME = process.env.CHROME_PATH || (() => {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { require('fs').accessSync(mac); return mac; } catch { return puppeteer.executablePath(); }
})();
const AGENCY   = process.env.IAR_AGENCY   || 'RICHARDSVILLE';
const USERNAME = process.env.IAR_USERNAME;
const PASSWORD = process.env.IAR_PASSWORD;
const POLL_MS  = 30_000;

let sessionCookies = null;
let lastSync       = null;
let syncStatus     = 'starting';
let currentData    = { active: [], pending: [], raw: null };
let rawSample      = null; // first response for debugging

// ── SSE state ───────────────────────────────────────────────────
const sseClients = new Set();
const seenIds    = new Set();
let   firstPoll  = true;

function broadcastNewIncidents(incidents) {
  if (!incidents.length || !sseClients.size) return;
  const msg = `data: ${JSON.stringify(incidents)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch {}
  }
}

// ── Telegram alerts ─────────────────────────────────────────────
const TG_TOKEN   = process.env.TELEGRAM_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendTelegram(incident) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  const type     = incident.type     || 'UNKNOWN CALL';
  const subtype  = incident.subtype  ? ` · ${incident.subtype}` : '';
  const address  = incident.address  || 'No address';
  const loc      = incident.locationName ? `${incident.locationName}\n` : '';
  const munic    = incident.municipality ? `${incident.municipality}\n` : '';
  const priority = incident.priority ? `Priority ${incident.priority}` : '';
  const cross    = incident.crossStreet ? `Cross: ${incident.crossStreet}\n` : '';
  const mapLink  = incident.lat ? `\n📍 https://maps.google.com/?q=${incident.lat},${incident.lng}` : '';

  const text = [
    `🚨 *PENDING CALL — ${type}${subtype}*`,
    ``,
    `${loc}${address}`,
    `${munic}${cross}`,
    priority,
    mapLink,
  ].filter(l => l !== undefined).join('\n').trim();

  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' });

  const req = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    if (res.statusCode !== 200) {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => console.error('Telegram error:', res.statusCode, d));
    }
  });
  req.on('error', e => console.error('Telegram request error:', e.message));
  req.write(body);
  req.end();
}

// ── Puppeteer auth ──────────────────────────────────────────────
async function authenticate() {
  console.log('🔐 Launching Chrome for IAR auth...');
  syncStatus = 'authenticating';

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setCookie({ name: 'CookieConsent', value: 'yes', domain: '.iamresponding.com' });

    console.log('  → Loading login page...');
    await page.goto('https://auth.iamresponding.com/login/member', { waitUntil: 'networkidle2', timeout: 30000 });

    await page.type('#Input_Agency',   AGENCY,   { delay: 60 });
    await page.type('#Input_Username', USERNAME, { delay: 60 });
    await page.type('#Input_Password', PASSWORD, { delay: 60 });

    console.log('  → Submitting credentials...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }),
      page.click('button[type="submit"]'),
    ]);

    const url = page.url();
    console.log('  → Post-login URL:', url);

    if (url.includes('/login/')) {
      const msg = await page.$eval('.validation-summary-errors, .text-danger', el => el.textContent.trim()).catch(() => 'Check credentials');
      throw new Error('Login failed — ' + msg);
    }

    // Navigate to coordinator API to seed cookies for that domain
    await page.goto('https://coordinator.iamresponding.com/api/IncidentList', { waitUntil: 'networkidle2', timeout: 15000 });
    const body = await page.evaluate(() => document.body.innerText);
    console.log('  → Raw IncidentList sample:', body.substring(0, 300));
    rawSample = body;

    // Grab all cookies across domains
    const allCookies = await page.cookies();
    sessionCookies = allCookies;
    console.log('✅ Auth complete —', allCookies.length, 'cookies');
    syncStatus = 'ok';

    // Parse first batch inline
    try { processResponse(JSON.parse(body)); } catch (_) {}

    return allCookies;
  } finally {
    await browser.close();
  }
}

// ── Parse early CAD notes from messageBody ──────────────────────
function parseBodyComments(messageBody) {
  if (!messageBody) return [];
  const section = messageBody.split(/Comments:\s*/i)[1];
  if (!section) return [];
  const results = [];
  // Entries are tab-indented, separated by \t---------------
  const blocks = section.split(/\t-{3,}/);
  for (const block of blocks) {
    const msgMatch  = block.match(/message:\s*(.+?)(?:\r?\n|$)/i);
    const timeMatch = block.match(/createdAt:\s*(.+?)(?:\r?\n|$)/i);
    if (msgMatch && timeMatch) {
      const createdAt = timeMatch[1].trim();
      results.push({
        message:       msgMatch[1].trim(),
        createdAt,
        createdAtISO:  new Date(createdAt).toISOString(),
        createdBy:     'CAD',
        createdAgency: '',
      });
    }
  }
  return results;
}

// ── Normalize incident data ─────────────────────────────────────
function normalize(inc) {
  let main = {};
  try { main = JSON.parse(inc.mainData || '{}'); } catch (_) {}

  let unitGroups = { onscene: [], enroute: [], available: [] };
  try { unitGroups = { onscene: [], enroute: [], available: [], ...JSON.parse(inc.groupedUnitData || '{}') }; } catch (_) {}

  let comments = [];
  try {
    const structured = JSON.parse(inc.commentData || '[]');
    const cad        = parseBodyComments(inc.messageBody);

    // Merge and dedup by message+timestamp
    const seen = new Set();
    const merged = [...structured, ...cad].filter(c => {
      const key = `${c.message}|${(c.createdAt || '').slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    merged.sort((a, b) => new Date(b.createdAtISO || b.createdAt || 0) - new Date(a.createdAtISO || a.createdAt || 0));
    comments = merged;
  } catch (_) {}

  let callerInfo = null;
  try {
    const ci = JSON.parse(inc.callerInfoData || '[]');
    if (ci.length) callerInfo = ci[0];
  } catch (_) {}

  // Extra caller/location data
  const ei = inc.incidentExtraInformation || {};

  // Extract CAD ID (e.g. CFS2658492) from messageBody
  let cadId = null;
  try {
    const m = (inc.messageBody || '').match(/ID:\s*:\s*(CFS\d+)/i);
    if (m) cadId = m[1];
  } catch (_) {}

  return {
    id:             String(inc.id),
    cadId:          cadId,
    type:           main.type            || '',
    subtype:        main.subtype         || '',
    subtypeCode:    main.subtypeCode     || '',
    typeCode:       main.typeCode        || '',
    priority:       main.priority        || '',
    address:        main.address         || inc.address || '',
    streetNum:      main.streetNum       || '',
    locationName:   main.locationName    || '',
    municipality:   main.municipality    || '',
    zipCode:        main.zipCode         || '',
    crossStreet:    main.crossStreet     || '',
    lat:            main.latitude,
    lng:            main.longitude,
    approximated:   main.approximatedLocation || false,
    // Caller GPS (where the 911 caller's phone is — may differ from incident)
    callerLat:      ei.latitudeFormat    || null,
    callerLng:      ei.longitudeFormat   || null,
    callerAccuracy: ei.uncertaintyRadiusFormat || null,
    callerLocTime:  ei.locationTimeFormat || null,
    callerName:     ei.callerName        || null,
    units:          unitGroups,
    comments:       comments,
    responders:     inc.responders       || [],
    callerInfo:     callerInfo,
    arrivedOn:      inc.arrivedOn,
    closed:         inc.closed === true || inc.closed === 'True' || inc.closed === 'true',
  };
}

function processResponse(data) {
  const list = Array.isArray(data) ? data
    : (data.incidents || data.Incidents || data.data || data.results || []);

  const normalized = list.map(normalize);

  // Detect and broadcast genuinely new (non-closed) incidents
  if (firstPoll) {
    normalized.forEach(i => seenIds.add(i.id));
    firstPoll = false;
  } else {
    const fresh = normalized.filter(i => !seenIds.has(i.id) && !i.closed);
    normalized.forEach(i => seenIds.add(i.id));
    broadcastNewIncidents(fresh);
    fresh.forEach(sendTelegram);
  }

  const active = normalized.filter(i => !i.closed);
  const closed = normalized.filter(i => i.closed);

  currentData = { active, closed, all: normalized };
  lastSync    = new Date().toISOString();
  syncStatus  = 'ok';

  normalized.forEach(i => {
    db.prepare(`
      INSERT INTO incidents (id, type, address, status, raw, last_seen)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type, address=excluded.address,
        status=excluded.status, raw=excluded.raw, last_seen=CURRENT_TIMESTAMP
    `).run(i.id, i.type, i.address, i.closed ? 'closed' : 'active', JSON.stringify(i));
  });
}

// ── Poll IAR API ────────────────────────────────────────────────
async function poll() {
  if (!sessionCookies) {
    try { await authenticate(); return; } catch (e) {
      console.error('Auth error:', e.message);
      syncStatus = 'auth_error';
      return;
    }
  }

  const cookieStr = sessionCookies.map(c => `${c.name}=${c.value}`).join('; ');

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'coordinator.iamresponding.com',
      path:     '/api/IncidentList',
      method:   'GET',
      headers:  {
        'Cookie':     cookieStr,
        'X-CSRF':     '1',
        'Accept':     'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 302 || res.statusCode === 403) {
          console.log('⚠️  Session expired, re-authing...');
          sessionCookies = null;
          syncStatus     = 'session_expired';
          resolve();
          return;
        }
        try {
          rawSample = body;
          processResponse(JSON.parse(body));
          syncStatus = 'ok';
          console.log(`[${new Date().toLocaleTimeString()}] Synced — ${currentData.all?.length ?? 0} incidents`);
        } catch (e) {
          console.error('Parse error:', e.message, '| body:', body.substring(0, 200));
          syncStatus = 'parse_error';
        }
        resolve();
      });
    });
    req.on('error', e => { console.error('Request error:', e.message); syncStatus = 'error'; resolve(); });
    req.end();
  });
}

// ── Routes ──────────────────────────────────────────────────────
app.get('/incidents', (_req, res) => {
  res.json({ ...currentData, lastSync, status: syncStatus, agency: AGENCY });
});

app.get('/status', (_req, res) => {
  res.json({ status: syncStatus, lastSync, agency: AGENCY, count: currentData.all?.length ?? 0 });
});

// Raw response for debugging — remove once working
app.get('/raw', (_req, res) => {
  res.type('text/plain').send(rawSample || 'no data yet');
});

// Recent history from DB
app.get('/history', (_req, res) => {
  const rows = db.prepare('SELECT * FROM incidents ORDER BY last_seen DESC LIMIT 50').all();
  res.json(rows);
});

// ── Telegram test ───────────────────────────────────────────────
app.get('/test-telegram', (_req, res) => {
  sendTelegram({
    type:         'STRUCTURE FIRE',
    subtype:      'RESIDENTIAL',
    address:      '123 Test St, Culpeper, VA',
    locationName: 'Test House',
    municipality: 'CULPEPER',
    crossStreet:  'Main St',
    priority:     '1',
    lat:          38.4732,
    lng:          -77.9961,
  });
  res.json({ ok: true, message: 'Telegram test sent — check your phone' });
});

// ── SSE stream ──────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: {"type":"connected"}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Serve built client ───────────────────────────────────────────
const clientDist = path.join(__dirname, '../client/dist');
const fs = require('fs');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ── Start ────────────────────────────────────────────────────────
const PORT = 3003;
app.listen(PORT, async () => {
  console.log(`✅ Culpeper Dispatch server on http://localhost:${PORT}`);
  await poll();
  setInterval(poll, POLL_MS);
});

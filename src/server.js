// O servidor do Loop: pagina publica, estado em JSON, painel interno por token
// de admin, e o relogio do motor. Sem login de carteira na tela: o admin
// digita o token uma vez; a chave do agente nunca passa por aqui.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { PORT, PUBLIC_URL, DATA_DIR, ADMIN_TOKEN, RULES, CHAIN, TOKEN, LINKS, VERSION, X_CREDS, TELEGRAM, PONS_TOKEN_URL, CANONICAL_HOST } from './config.js';
import { loadState, saveState } from './state.js';
import { Engine } from './engine.js';
import { realAdapter } from './adapter.js';
import { protocolTerms, getBalance } from './chain.js';
import { postTweet, validCreds, postTelegram, validTelegram } from './x.js';
import { voiceEnabled } from './voice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

// ---------------------------------------------------------------------------
// Token de admin: env, ou gerado uma vez e guardado em DATA_DIR/admin.token.
function adminToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'admin.token');
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t; } catch { /* nao existe ainda */ }
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, t);
  return t;
}
const ADMIN = adminToken();
console.log(`[loop] admin token: ${ADMIN.slice(0, 4)}… (full token in ${ADMIN_TOKEN ? 'ADMIN_TOKEN env' : path.join(DATA_DIR, 'admin.token')})`);

// ---------------------------------------------------------------------------
// Canais: X e Telegram, se as chaves existirem. Silencio noturno so para os
// canais; o pedido de autorizacao passa sempre (e o agente pedindo).
function inQuietHours(now = new Date()) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(RULES.quietHours || '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const h = now.getUTCHours();
  return a <= b ? h >= a && h < b : h >= a || h < b;
}
async function publish(event, text) {
  const urgent = event.kind === 'final_requested' || event.kind === 'needs_gas';
  if (inQuietHours() && !urgent) return null;
  const out = { tweetId: null, telegramId: null };
  if (validCreds(X_CREDS)) {
    try { out.tweetId = (await postTweet(X_CREDS, text)).id; } catch (e) { console.error('[x]', e.message); }
  }
  if (validTelegram(TELEGRAM)) {
    const extra = event.kind === 'final_requested' ? `\n\nAuthorize at ${PUBLIC_URL}/#admin` : '';
    try { out.telegramId = (await postTelegram(TELEGRAM, text + extra)).id; } catch (e) { console.error('[telegram]', e.message); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motor.
const adapter = realAdapter();
const state = loadState();
const engine = new Engine({ adapter, state, save: (s) => saveState(s), publish });
console.log(`[loop] agent ${adapter.agent} (${adapter.canSign ? 'signing' : 'observer, no key'}) on ${CHAIN.name}`);

// ETH em dolar, para a pagina falar a lingua do Michel (mcap em USD).
let usdCache = { at: 0, value: null };
async function ethUsd() {
  if (Date.now() - usdCache.at < 5 * 60_000) return usdCache.value;
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    usdCache = { at: Date.now(), value: Number(j?.data?.amount) || null };
  } catch { usdCache = { at: Date.now(), value: usdCache.value }; }
  return usdCache.value;
}

// ---------------------------------------------------------------------------
// App.
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  if (CANONICAL_HOST && req.method === 'GET' && !req.path.startsWith('/api/') && String(req.hostname || '').toLowerCase() !== CANONICAL_HOST) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // QA_ALLOW_FRAMING so para a captura mobile por iframe no Edge headless.
  if (!process.env.QA_ALLOW_FRAMING) res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  else if (/\.(html|js|css)$/.test(req.path) || req.path === '/') res.setHeader('Cache-Control', 'no-cache');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION, phase: state.phase, lastTickAt: state.lastTickAt }));

app.get('/api/state', async (req, res) => {
  const [usd, terms, bal] = await Promise.all([
    ethUsd(),
    protocolTerms().catch(() => null),
    adapter.agent ? getBalance(adapter.agent).catch(() => null) : null,
  ]);
  const v = engine.view({ ethUsd: usd, balanceWei: bal, terms });
  res.json({
    ...v,
    voice: voiceEnabled(),
    channels: { x: validCreds(X_CREDS), telegram: validTelegram(TELEGRAM) },
    links: { x: LINKS.x || null, telegram: LINKS.telegram || null, explorer: CHAIN.explorer, ponsUrl: PONS_TOKEN_URL, site: PUBLIC_URL },
    terms: terms ? { launchFeeEth: String(Number(terms.launchFee) / 1e18), graduationEth: String(Number(terms.graduationThreshold) / 1e18), supply: String(terms.supply), curveSellable: String(terms.curveSellable) } : null,
    now: new Date().toISOString(),
  });
});

// Painel interno. Token no cabecalho; tentativas erradas sao limitadas por IP.
const attempts = new Map();
function admin(req, res, next) {
  const ip = req.ip || 'x';
  const rec = attempts.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - rec.at > 60_000) { rec.n = 0; rec.at = Date.now(); }
  if (rec.n >= 10) return res.status(429).json({ error: 'too many attempts; wait a minute' });
  const given = String(req.get('x-admin-token') || '');
  const ok = given.length === ADMIN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN));
  if (!ok) { rec.n += 1; attempts.set(ip, rec); return res.status(401).json({ error: 'bad admin token' }); }
  next();
}
const act = (fn) => async (req, res) => {
  try { res.json({ ok: true, result: await fn(req) }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
};
app.get('/api/admin/check', admin, (req, res) => res.json({ ok: true }));
app.post('/api/admin/kill', admin, act(async () => { const l = await engine.kill(); setTimeout(() => engine.tick(), 1500); return { loop: l.n }; }));
app.post('/api/admin/launch-now', admin, act(async () => { engine.skipRest(); setTimeout(() => engine.tick(), 500); return { phase: state.phase }; }));
app.post('/api/admin/authorize', admin, act(async () => { const f = engine.authorizeFinal('admin panel'); setTimeout(() => engine.tick(), 500); return f; }));
app.post('/api/admin/pause', admin, act(async () => { engine.pause(); return { paused: true }; }));
app.post('/api/admin/resume', admin, act(async () => { engine.resume(); setTimeout(() => engine.tick(), 500); return { paused: false }; }));
app.post('/api/admin/tick', admin, act(async () => { await engine.tick(); return { phase: state.phase }; }));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));
app.use((req, res) => res.status(404).send('not found'));

app.listen(PORT, () => {
  console.log(`[loop] ${TOKEN.name} ($${TOKEN.symbol}) listening on ${PORT}; site ${PUBLIC_URL}; data ${DATA_DIR}`);
  setTimeout(() => engine.tick(), 5000);
  setInterval(() => engine.tick(), RULES.tickSec * 1000);
});

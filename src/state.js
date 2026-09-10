// O estado do Loop: um JSON so em DATA_DIR, escrita atomica (tmp + rename).
// Cabe tudo aqui: os loops, o pote, os posts, o pedido de queima final.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const STATE_FILE = process.env.STATE_FILE || path.join(DATA_DIR, 'state.json');

export function emptyState() {
  return {
    version: 1,
    phase: 'idle',            // idle | live | dying | resting | awaiting_authorization | final_launching | final_done | needs_gas | observer
    paused: false,
    loops: [],
    posts: [],
    log: [],
    stats: { loopsBorn: 0, loopsDead: 0, feesTotalEth: '0', soldTotalEth: '0', buysTotal: 0 },
    final: null,              // { requestedAt, potEth, curveCostEth, authorizedAt, authorizedVia, launchTx, burnTx, burnedTokens }
    restUntil: null,
    lastScanBlock: null,
    lastTickAt: null,
    lastError: null,
    curveCost: null,          // { eth, tokens, at }
  };
}

export function loadState(file = STATE_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...emptyState(), ...raw };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[state] could not read ${file}: ${e.message}`);
    return emptyState();
  }
}

export function saveState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

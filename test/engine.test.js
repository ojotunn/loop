// Provas do motor com uma chain de mentira e relogio controlado. Nada aqui
// toca a rede nem o disco do projeto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, formatEther } from 'viem';
import { Engine } from '../src/engine.js';
import { emptyState } from '../src/state.js';

const E = (s) => parseEther(String(s));
const H = 3600_000;

class FakeChain {
  constructor({ balance = '0.06' } = {}) {
    this.agent = '0x00000000000000000000000000000000000A6E17';
    this.canSign = true;
    this.t = Date.parse('2026-09-11T12:00:00Z');
    this.bal = E(balance);
    this.block = 1000n;
    this.tokens = new Map();      // token -> { curve, held, state, buys: [], exists }
    this.escrow = 0n;
    this.calls = [];
    this.cost = { wei: E('4.4'), tokensOut: 714_000_000n * 10n ** 18n, at: 'now' };
    this.next = 1;
    this.termsObj = { launchFee: E('0.0005'), launchEnabled: true, graduationThreshold: E('4.2'), supply: 10n ** 27n, curveSellable: 714_285_714n * 10n ** 18n, economics: '0x00' };
  }
  now() { return this.t; }
  advance(ms) { this.t += ms; this.block += BigInt(Math.max(1, Math.floor(ms / 1000))); }
  async terms() { return this.termsObj; }
  async canLaunch() { return true; }
  async balance() { return this.bal; }
  async blockNumber() { return this.block; }
  randomSalt() { return '0x' + 'ab'.repeat(32); }
  launchParams({ salt, description }) { return { salt, description }; }
  explainRevert(e) { return { message: String(e.message) }; }
  ponsUrl(t) { return `pons/${t}`; }
  async simulateLaunch({ devBuyWei }) {
    if (this.failSim) throw new Error('LaunchEconomicsMismatch');
    const id = this.next;
    return { token: `0xT${id}`, curve: `0xC${id}`, tokensOut: devBuyWei * 1000n };
  }
  async launch({ devBuyWei, terms }) {
    this.calls.push(['launch', formatEther(devBuyWei)]);
    const id = this.next++;
    const token = `0xT${id}`, curve = `0xC${id}`;
    this.bal -= devBuyWei + terms.launchFee;
    const tokensOut = devBuyWei * 1000n;
    this.tokens.set(token, { curve, held: tokensOut, exists: true, buys: [], state: { quoteReserve: E('1.68') + devBuyWei, tokenReserve: 10n ** 27n, realQuote: devBuyWei, sellable: 0n, graduated: false, readyToGraduate: false, deployer: this.agent, buybackEnabled: false, totalSupply: 10n ** 27n, priceEth: 0.000001, mcapEth: 1, raisedEth: formatEther(devBuyWei), unswept: 0n } });
    return { ok: true, hash: `0xhash${id}`, token, curve, tokensOut, block: this.block };
  }
  rec(curve) { for (const [t, r] of this.tokens) if (r.curve === curve) return { token: t, ...r }; return null; }
  async launchedToken(token) { const r = this.tokens.get(token); return r ? { exists: true, curve: r.curve } : { exists: false }; }
  async curveState(curve) { return this.rec(curve).state; }
  async buysBetween(curve, from, to) { const r = this.rec(curve); const out = r.buys.filter((b) => b.block >= from && b.block <= to); return out; }
  async escrowBalance() { return this.escrow; }
  async tokenBalance(token) { return this.tokens.get(token)?.held ?? 0n; }
  async wholeCurveCost() { return this.cost; }
  async quoteSell(curve, token, tokensIn) { return tokensIn / 1000n; }
  async sell({ curve, tokensIn, minQuoteOut }) {
    this.calls.push(['sell', formatEther(tokensIn / 1000n)]);
    const r = this.rec(curve); assert.ok(minQuoteOut <= tokensIn / 1000n);
    this.tokens.get(r.token).held -= tokensIn; this.bal += tokensIn / 1000n;
    return { ok: true, hash: '0xsell' };
  }
  async sweep({ curve }) { this.calls.push(['sweep']); const r = this.rec(curve); this.escrow += r.state.unswept; r.state.unswept = 0n; return { ok: true, hash: '0xsweep' }; }
  async claim() { this.calls.push(['claim', formatEther(this.escrow)]); this.bal += this.escrow; this.escrow = 0n; return { ok: true, hash: '0xclaim' }; }
  async burn({ token, amount }) { this.calls.push(['burn', formatEther(amount)]); this.tokens.get(token).held -= amount; return { ok: true, hash: '0xburn' }; }
  // helpers
  buy(curve, eth, who = '0xB0B') { const r = this.rec(curve); r.buys.push({ recipient: who, quoteIn: E(eth), block: this.block }); r.state.unswept += E(eth) / 10n; }
  setMcap(curve, m) { this.rec(curve).state.mcapEth = m; }
}

const rules = { tickSec: 60, deathIdleHours: 6, deathDropPct: 80, maxLifeHours: 48, stillbornHours: 6, rebirthDelayMin: 15, gasReserveEth: '0.003', minDevBuyEth: '0.001', finalMarginPct: 2, sellSlippagePct: 3, whaleEth: '0.05', quietHours: '' };
const make = (opts) => { const chain = new FakeChain(opts); const state = emptyState(); const published = []; const eng = new Engine({ adapter: chain, state, save: () => {}, rules, publish: async (ev, text) => { published.push([ev.kind, text]); return { tweetId: 't' }; }, log: { log() {} } }); return { chain, state, eng, published }; };

test('loop 1 is born with the whole pot (balance - reserve - fee)', async () => {
  const { chain, state, eng, published } = make({ balance: '0.06' });
  await eng.tick();
  assert.equal(state.phase, 'live');
  assert.equal(state.loops.length, 1);
  assert.equal(state.loops[0].n, 1);
  assert.equal(state.loops[0].devBuyEth, '0.0565');
  assert.deepEqual(chain.calls[0], ['launch', '0.0565']);
  assert.equal(published[0][0], 'born');
  assert.match(published[0][1], /alive/);
});

test('buys are counted, whales get a post, peak tracks mcap', async () => {
  const { chain, state, eng, published } = make();
  await eng.tick();
  const loop = state.loops[0];
  chain.advance(60_000);
  chain.buy(loop.curve, '0.01');
  chain.buy(loop.curve, '0.2', '0xWHALE');
  chain.setMcap(loop.curve, 25);
  await eng.tick();
  assert.equal(loop.buys, 2);
  assert.equal(loop.peakMcapEth, 25);
  assert.equal(loop.biggestBuyEth, '0.2');
  assert.ok(published.some(([k]) => k === 'whale'));
  // o proprio agente nao conta como comprador
  chain.buy(loop.curve, '0.5', chain.agent);
  chain.advance(60_000);
  await eng.tick();
  assert.equal(loop.buys, 2);
});

test('death by idle + floor: sells the position, sweeps, claims, rests, then is reborn bigger', async () => {
  const { chain, state, eng, published } = make({ balance: '0.06' });
  await eng.tick();
  const loop = state.loops[0];
  chain.advance(60_000);
  chain.buy(loop.curve, '1');          // 0.1 ETH of fees park on the curve
  chain.setMcap(loop.curve, 100);
  await eng.tick();
  assert.equal(loop.peakMcapEth, 100);
  chain.advance(3 * H);
  chain.setMcap(loop.curve, 15);        // below 20% of peak but not idle long enough
  await eng.tick();
  assert.equal(loop.status, 'live');
  chain.advance(4 * H);                 // now 7h idle
  await eng.tick();
  assert.equal(loop.status, 'dead');
  assert.equal(loop.deathReason, 'no buys and mcap below the floor');
  assert.equal(loop.soldEth, '0.0565');
  assert.equal(loop.feesEth, '0.1');
  assert.equal(state.phase, 'resting');
  assert.deepEqual(chain.calls.map((c) => c[0]), ['launch', 'sell', 'sweep', 'claim']);
  assert.equal(state.stats.feesTotalEth, '0.1');
  assert.ok(published.some(([k, t]) => k === 'died' && /dead/.test(t)));
  // descanso: nao lanca ainda
  chain.advance(5 * 60_000);
  await eng.tick();
  assert.equal(state.loops.length, 1);
  assert.equal(state.phase, 'resting');
  // passou o descanso: loop 2 nasce com o pote maior (0.06 - 0.0005 + 0.1 - 0.003 - 0.0005)
  chain.advance(11 * 60_000);
  await eng.tick();
  assert.equal(state.loops.length, 2);
  assert.equal(state.loops[1].n, 2);
  assert.equal(state.loops[1].devBuyEth, '0.156');
  assert.equal(state.phase, 'live');
});

test('stillborn: nobody bought for 6h', async () => {
  const { chain, state, eng, published } = make();
  await eng.tick();
  chain.advance(6 * H + 1000);
  await eng.tick();
  assert.equal(state.loops[0].status, 'dead');
  assert.equal(state.loops[0].deathReason, 'stillborn');
  assert.ok(published.some(([k]) => k === 'stillborn'));
});

test('max life: dies at 48h even with buys', async () => {
  const { chain, state, eng } = make();
  await eng.tick();
  const loop = state.loops[0];
  for (let i = 0; i < 47; i++) { chain.advance(H); chain.buy(loop.curve, '0.01'); chain.setMcap(loop.curve, 50); await eng.tick(); }
  assert.equal(loop.status, 'live');
  chain.advance(2 * H);
  await eng.tick();
  assert.equal(loop.status, 'dead');
  assert.equal(loop.deathReason, 'max life reached');
});

test('graduation: no sell, fees claimed, loop marked graduated', async () => {
  const { chain, state, eng } = make();
  await eng.tick();
  const loop = state.loops[0];
  chain.escrow = E('0.3');
  chain.rec(loop.curve).state.graduated = true;
  chain.advance(60_000);
  await eng.tick();
  assert.equal(loop.status, 'graduated');
  assert.equal(loop.feesEth, '0.3');
  assert.ok(!chain.calls.some((c) => c[0] === 'sell'));
  assert.ok(chain.calls.some((c) => c[0] === 'claim'));
});

test('needs gas: no launch below the minimum, one post per hour', async () => {
  const { chain, state, eng } = make({ balance: '0.002' });
  await eng.tick();
  assert.equal(state.phase, 'needs_gas');
  assert.equal(state.loops.length, 0);
  assert.equal(state.posts.filter((p) => p.kind === 'needs_gas').length, 1);
  chain.advance(10 * 60_000);
  await eng.tick();
  assert.equal(state.posts.filter((p) => p.kind === 'needs_gas').length, 1);
  chain.advance(H);
  await eng.tick();
  assert.equal(state.posts.filter((p) => p.kind === 'needs_gas').length, 2);
});

test('the end: pot covers the curve -> asks, waits, launches and burns only after authorization', async () => {
  const { chain, state, eng, published } = make({ balance: '0.06' });
  await eng.tick();
  chain.buy(state.loops[0].curve, '0.01');
  chain.advance(60_000);
  await eng.tick();
  // botao interno: vender e lancar a proxima
  await eng.kill();
  assert.equal(state.loops[0].status, 'dead');
  assert.equal(state.loops[0].deathReason, 'manual: sell and launch the next');
  assert.equal(state.restUntil, null);
  // pote agora cobre a curva inteira
  chain.bal = E('5');
  await eng.tick();
  assert.equal(state.phase, 'awaiting_authorization');
  assert.equal(state.loops.length, 1, 'must not launch without authorization');
  assert.equal(state.final.curveCostEth, '4.4');
  assert.ok(published.some(([k, t]) => k === 'final_requested' && /authorize/i.test(t)));
  chain.advance(3 * H);
  await eng.tick();
  assert.equal(state.loops.length, 1, 'still waiting');
  await assert.rejects(eng.kill(), /no live loop/);
  eng.authorizeFinal('admin panel');
  await eng.tick();
  assert.equal(state.phase, 'final_done');
  assert.equal(state.loops.length, 2);
  const last = state.loops[1];
  assert.equal(last.status, 'burned');
  assert.equal(last.devBuyEth, '4.488');            // 4.4 * 1.02
  const burn = chain.calls.find((c) => c[0] === 'burn');
  assert.ok(burn);
  assert.equal(burn[1], '4488');                     // tudo que recebeu (1000 tokens por ETH na chain falsa)
  assert.equal(state.final.burnTx, '0xburn');
  assert.ok(published.some(([k]) => k === 'burned'));
  // depois do fim, nao lanca mais nada
  chain.bal = E('9');
  chain.advance(H);
  await eng.tick();
  assert.equal(state.loops.length, 2);
});

test('with the automatic rules off (0), a loop only dies by the button', async () => {
  const chain = new FakeChain();
  const state = emptyState();
  const eng = new Engine({ adapter: chain, state, save: () => {}, rules: { ...rules, deathIdleHours: 0, maxLifeHours: 0, stillbornHours: 0 }, publish: null, log: { log() {} } });
  await eng.tick();
  const loop = state.loops[0];
  chain.advance(200 * H);            // oito dias sem ninguem comprar, mcap no chao
  chain.setMcap(loop.curve, 0.01);
  await eng.tick();
  assert.equal(loop.status, 'live');
  await eng.kill();
  assert.equal(loop.status, 'dead');
  assert.match(loop.deathReason, /manual/);
});

test('authorize outside the gate is refused', () => {
  const { eng } = make();
  assert.throws(() => eng.authorizeFinal(), /nothing to authorize/);
});

test('paused: the tick does nothing', async () => {
  const { state, eng } = make();
  eng.pause();
  await eng.tick();
  assert.equal(state.loops.length, 0);
  eng.resume();
  await eng.tick();
  assert.equal(state.loops.length, 1);
});

test('a launch that landed on-chain during a crash is recovered, not repeated', async () => {
  const { chain, state, eng } = make();
  // simula: previu 0xT1, assinou, o processo caiu antes de gravar o loop
  await chain.launch({ devBuyWei: E('0.05'), terms: chain.termsObj });
  state.pendingLaunch = { n: 1, salt: '0x', token: '0xT1', curve: '0xC1', devBuyEth: '0.05', final: false, at: new Date(chain.now() - 60_000).toISOString() };
  state.phase = 'launching';
  await eng.tick();
  assert.equal(state.loops.length, 1);
  assert.equal(state.loops[0].token, '0xT1');
  assert.equal(state.phase, 'live');
  assert.equal(chain.calls.filter((c) => c[0] === 'launch').length, 1);
});

test('a failed simulation backs off instead of spamming', async () => {
  const { chain, state, eng } = make();
  chain.failSim = true;
  await eng.tick();
  assert.equal(state.phase, 'error');
  assert.equal(state.loops.length, 0);
  chain.failSim = false;
  await eng.tick();
  assert.equal(state.loops.length, 0, 'still in backoff');
  chain.advance(11 * 60_000);
  await eng.tick();
  assert.equal(state.loops.length, 1);
});

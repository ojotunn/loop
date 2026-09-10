// Provas contra a mainnet da Robinhood Chain: so leitura e eth_call (com saldo
// fictico por state override). Nada assina, nada gasta. Precisa de rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import * as chain from '../src/chain.js';
import { ERC20_ABI } from '../src/abi.js';

const CDTEST = '0x94F734Ca259aB04B76786f5D5E2dE24ABBc199e5';
const CDTEST_CURVE = '0x79830F768A5be8C4Ce9617DE6661f48B64f811B1';
const DEV = '0x1fdC1a53F3336690A618D7701F64aEB280E135D0';
const THROWAWAY = '0x000000000000000000000000000000000000a6e1';

test('pons terms: fee, supply, sellable share of the curve', async () => {
  const t = await chain.protocolTerms({ fresh: true });
  assert.equal(chain.formatEther(t.launchFee), '0.0005');
  assert.equal(t.supply, 10n ** 27n);
  assert.equal(chain.formatEther(t.graduationThreshold), '4.2');
  const share = Number(t.curveSellable * 10_000n / t.supply) / 100;
  console.log(`  curve sells ${share}% of supply (${chain.formatUnits(t.curveSellable, 18)} tokens)`);
  assert.ok(share > 70 && share < 72);
});

test('launch simulation from a throwaway wallet returns token, curve and tokens', async () => {
  const terms = await chain.protocolTerms();
  const params = chain.launchParams({ terms, agent: THROWAWAY, salt: chain.randomSalt(), description: 'proof' });
  const sim = await chain.simulateLaunch({ terms, params, devBuyWei: chain.parseEther('0.05'), from: THROWAWAY });
  assert.match(sim.token, /^0x[0-9a-fA-F]{40}$/);
  assert.match(sim.curve, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(sim.tokensOut > 0n);
  console.log(`  0.05 ETH at birth -> ${chain.formatUnits(sim.tokensOut, 18)} tokens; predicted ${sim.token}`);
});

test('whole-curve cost: the final buy is sized by simulation', async () => {
  const terms = await chain.protocolTerms();
  const c = await chain.wholeCurveCost({ terms, agent: THROWAWAY, fresh: true });
  const eth = Number(chain.formatEther(c.wei));
  console.log(`  whole curve costs ${eth.toFixed(4)} ETH -> ${chain.formatUnits(c.tokensOut, 18)} tokens (curve sells ${chain.formatUnits(terms.curveSellable, 18)})`);
  assert.ok(eth > 4.2 && eth < 6, `unexpected cost ${eth}`);
  assert.ok(c.tokensOut * 10_000n / terms.curveSellable >= 9995n);
});

test('a revert is explained (creator tax above the pons maximum)', async () => {
  const terms = await chain.protocolTerms();
  const params = { ...chain.launchParams({ terms, agent: THROWAWAY, salt: chain.randomSalt() }), creatorTaxBps: 9000 };
  await assert.rejects(chain.simulateLaunch({ terms, params, devBuyWei: 0n, from: THROWAWAY }), (e) => {
    const r = chain.explainRevert(e);
    console.log(`  revert -> ${r.code}: ${r.message}`);
    return r.code === 'CreatorTaxTooHigh';
  });
});

test('curve state of a live token reads mcap, raised and unswept fees', async () => {
  const cs = await chain.curveState(CDTEST_CURVE, CDTEST);
  assert.ok(cs.mcapEth > 0);
  assert.ok(cs.unswept >= 0n);
  assert.equal(cs.deployer.toLowerCase(), DEV.toLowerCase());
  console.log(`  CDTEST mcap ${cs.mcapEth.toFixed(3)} ETH, raised ${cs.raisedEth} ETH, unswept ${chain.formatEther(cs.unswept)} ETH, graduated ${cs.graduated}`);
});

test('sell quote: the dev position on CDTEST can be sold back to the curve', async () => {
  const held = await chain.tokenBalance(CDTEST, DEV);
  if (held === 0n) { console.log('  dev wallet holds no CDTEST any more; skipped'); return; }
  const out = await chain.quoteSell({ curve: CDTEST_CURVE, token: CDTEST, from: DEV, tokensIn: held });
  assert.ok(out > 0n);
  console.log(`  ${chain.formatUnits(held, 18)} CDTEST -> ${chain.formatEther(out)} ETH`);
});

test('burn is a plain transfer to the dead address (simulated)', async () => {
  const held = await chain.tokenBalance(CDTEST, DEV);
  if (held === 0n) { console.log('  no CDTEST to burn; skipped'); return; }
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [chain.DEAD_ADDRESS, 10n ** 18n] });
  const res = await chain.client.call({ account: DEV, to: CDTEST, data });
  assert.equal(decodeFunctionResult({ abi: ERC20_ABI, functionName: 'transfer', data: res.data }), true);
});

test('buy events can be read from the curve', async () => {
  const latest = await chain.blockNumber();
  const from = latest > 60_000n ? latest - 60_000n : 0n;
  const buys = await chain.curveBuysBetween(CDTEST_CURVE, from, latest);
  console.log(`  ${buys.length} buys on CDTEST in the last 60k blocks`);
  assert.ok(Array.isArray(buys));
});

test('the agent wallet exposes only launch, sell, sweep, claim and burn', () => {
  const w = chain.agentWallet('0x' + '11'.repeat(32));
  assert.deepEqual(Object.keys(w).sort(), ['address', 'burn', 'claim', 'launch', 'sell', 'sweep']);
  assert.match(w.address, /^0x/);
});

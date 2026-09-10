// Tudo que toca a Robinhood Chain. Leitura livre; escrita so pela carteira do
// agente e so pelas cinco funcoes do fim do arquivo: lancar, vender, varrer,
// sacar e queimar. Nao existe "mandar ETH para X" aqui de proposito: a
// carteira so fala com a pons, com a curva do proprio token e com o endereco
// de queima. Quem tem a chave (o Michel) faz o resto pela propria carteira.
import crypto from 'node:crypto';
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, toHex, pad,
  decodeErrorResult, parseEventLogs, parseEther, formatEther, formatUnits, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN, CONTRACTS, ZERO_ADDRESS, TOKEN } from './config.js';
import { FACTORY_ABI, ROUTER_ABI, CURVE_ABI, ERC20_ABI, ESCROW_ABI, ALL_ERRORS, DEAD_ADDRESS } from './abi.js';

export { parseEther, formatEther, formatUnits, getAddress, DEAD_ADDRESS };

export const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CHAIN.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CHAIN.explorer } },
});

export const client = createPublicClient({ chain, transport: http(CHAIN.rpc, { timeout: 20_000, retryCount: 2 }) });

const factory = { address: CONTRACTS.factory, abi: FACTORY_ABI };
const escrow = { address: CONTRACTS.feeEscrow, abi: ESCROW_ABI };

// ---------------------------------------------------------------------------
// Termos da pons (taxa de lancamento, supply, limiar de graduacao). Cache de
// um minuto: a pons pode mudar pelo owner, e o expectedEconomics pina o cotado.
let termsCache = { at: 0, value: null };
export async function protocolTerms({ fresh = false } = {}) {
  if (!fresh && termsCache.value && Date.now() - termsCache.at < 60_000) return termsCache.value;
  const configId = TOKEN.launchConfigId;
  const [launchFee, maxCreatorTaxBps, launchEnabled, config, economics] = await Promise.all([
    client.readContract({ ...factory, functionName: 'launchFee' }),
    client.readContract({ ...factory, functionName: 'maxCreatorTaxBps' }),
    client.readContract({ ...factory, functionName: 'launchEnabled' }),
    client.readContract({ ...factory, functionName: 'getLaunchConfig', args: [configId] }),
    client.readContract({ ...factory, functionName: 'previewLaunchEconomics', args: [configId, ZERO_ADDRESS] }),
  ]);
  const value = {
    configId,
    launchFee,
    maxCreatorTaxBps: Number(maxCreatorTaxBps),
    launchEnabled,
    supply: config.supply,
    curveFeeBps: Number(config.curveFeeBps),
    phantomQuote: config.phantomQuote,
    graduationThreshold: config.graduationThreshold,
    configEnabled: config.enabled,
    economics,
    // Quanto do supply a curva vende ate graduar (x*y=k com reserva virtual):
    // reservado para o pool = supply * phantom / (phantom + limiar).
    curveSellable: config.supply - (config.supply * config.phantomQuote) / (config.phantomQuote + config.graduationThreshold),
    fetchedAt: new Date().toISOString(),
  };
  termsCache = { at: Date.now(), value };
  return value;
}

export const canLaunch = (address) => client.readContract({ ...factory, functionName: 'canLaunch', args: [address] });
export const getBalance = (address) => client.getBalance({ address });
export const blockNumber = () => client.getBlockNumber();
export const escrowBalance = (recipient) => client.readContract({ ...escrow, functionName: 'balanceOf', args: [recipient] });
export const tokenBalance = (token, owner) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
export const launchedToken = (token) => client.readContract({ ...factory, functionName: 'getLaunchedToken', args: [token] }).catch(() => null);

// ---------------------------------------------------------------------------
// Estado vivo de uma curva.
export async function curveState(curveAddr, token) {
  const curve = { address: curveAddr, abi: CURVE_ABI };
  const [reserves, realQuote, sellable, graduated, readyToGraduate, deployer, buybackEnabled, totalSupply, balance] = await Promise.all([
    client.readContract({ ...curve, functionName: 'getReserves' }),
    client.readContract({ ...curve, functionName: 'realQuoteReserve' }),
    client.readContract({ ...curve, functionName: 'sellableTokens' }),
    client.readContract({ ...curve, functionName: 'graduated' }),
    client.readContract({ ...curve, functionName: 'readyToGraduate' }),
    client.readContract({ ...curve, functionName: 'deployer' }),
    client.readContract({ ...curve, functionName: 'buybackEnabled' }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }),
    client.getBalance({ address: curveAddr }),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  const priceEth = tokenReserve > 0n ? Number(quoteReserve) / Number(tokenReserve) : 0;
  return {
    quoteReserve, tokenReserve, realQuote, sellable, graduated, readyToGraduate, deployer, buybackEnabled, totalSupply,
    priceEth,
    mcapEth: priceEth * Number(formatUnits(totalSupply, 18)),
    raisedEth: formatEther(realQuote),
    // Taxas ainda paradas na curva (antes de varrer): saldo menos a reserva real.
    unswept: balance > realQuote ? balance - realQuote : 0n,
  };
}

// Compras de terceiros na curva entre dois blocos (eventos CurveBuy).
export async function curveBuysBetween(curveAddr, fromBlock, toBlock) {
  const logs = await client.getLogs({
    address: curveAddr,
    event: CURVE_ABI.find((i) => i.type === 'event' && i.name === 'CurveBuy'),
    fromBlock, toBlock,
  });
  return logs.map((l) => ({ buyer: l.args.buyer, recipient: l.args.recipient, quoteIn: l.args.quoteIn, tokensOut: l.args.tokensOut, block: l.blockNumber, tx: l.transactionHash }));
}

// ---------------------------------------------------------------------------
// Montagem e simulacao do lancamento (com dev buy vai pelo router: lanca e
// compra na mesma transacao, o agente fica isento do snipe tax).
export const randomSalt = () => `0x${crypto.randomBytes(32).toString('hex')}`;

export function launchParams({ terms, agent, salt, description }) {
  return {
    name: TOKEN.name,
    symbol: TOKEN.symbol,
    logo: TOKEN.logo || '',
    description: description || TOKEN.description || '',
    socials: { twitter: TOKEN.twitter || '', telegram: TOKEN.telegram || '', discord: '', website: TOKEN.website || '', farcaster: '' },
    creatorFeeRecipient: agent,
    creatorTaxBps: TOKEN.creatorTaxBps,
    buybackEnabled: false,
    expectedEconomics: terms.economics,
    salt,
  };
}

export function buildLaunchTx({ params, devBuyWei, recipient, launchFee, minTokensOut = 0n, configId = TOKEN.launchConfigId }) {
  if (devBuyWei > 0n) {
    return {
      via: 'router',
      to: CONTRACTS.router,
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'launchAndBuy', args: [params, configId, ZERO_ADDRESS, devBuyWei, minTokensOut, recipient, []] }),
      value: launchFee + devBuyWei,
    };
  }
  return {
    via: 'factory',
    to: CONTRACTS.factory,
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'launchToken', args: [params, configId, ZERO_ADDRESS] }),
    value: launchFee,
  };
}

// eth_call com saldo fictico (state override): simula antes de ter ETH, e com
// endereco descartavel para as provas. A RPC publica da Robinhood aceita.
export async function simulate({ from, to, data, value = 0n, fund = true }) {
  const opts = { account: from, to, data, value };
  if (fund) opts.stateOverride = [{ address: from, balance: value + parseEther('0.05') }];
  const res = await client.call(opts);
  return res.data;
}

export function decodeLaunchResult(via, data) {
  if (via === 'router') {
    const [token, curve, tokensOut] = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'launchAndBuy', data });
    return { token, curve, tokensOut };
  }
  const [token, curve] = decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'launchToken', data });
  return { token, curve, tokensOut: 0n };
}

export async function simulateLaunch({ terms, params, devBuyWei, from }) {
  const tx = buildLaunchTx({ params, devBuyWei, recipient: from, launchFee: terms.launchFee });
  const data = await simulate({ from, to: tx.to, data: tx.data, value: tx.value, fund: true });
  return { tx, ...decodeLaunchResult(tx.via, data) };
}

// Quanto custa comprar a curva inteira num lancamento novo: busca binaria pelo
// menor dev buy cujos tokens recebidos alcancam o que a curva vende. Cada passo
// e um eth_call; roda so quando nao ha loop vivo e fica em cache dez minutos.
let costCache = { at: 0, value: null };
export async function wholeCurveCost({ terms, agent, fresh = false } = {}) {
  if (!fresh && costCache.value && Date.now() - costCache.at < 10 * 60_000) return costCache.value;
  const params = launchParams({ terms, agent, salt: randomSalt() });
  const target = (terms.curveSellable * 9995n) / 10_000n; // 99,95% do que a curva vende
  let lo = 0n, hi = terms.graduationThreshold * 2n, best = null;
  // Espaco entre sondas: a RPC publica corta rajadas.
  const probe = async (wei) => {
    await new Promise((r) => setTimeout(r, 250));
    try { return (await simulateLaunch({ terms, params, devBuyWei: wei, from: agent })).tokensOut; } catch { return null; }
  };
  // Confere que o teto alcanca a meta; se nem 2x o limiar alcanca, desiste.
  const top = await probe(hi);
  if (top === null || top < target) throw new Error('could not size the whole-curve buy (simulation)');
  for (let i = 0; i < 24 && hi - lo > parseEther('0.0005'); i++) {
    const mid = (lo + hi) / 2n;
    const out = await probe(mid);
    if (out !== null && out >= target) { best = { wei: mid, tokensOut: out }; hi = mid; } else lo = mid;
  }
  const value = { wei: best?.wei ?? hi, tokensOut: best?.tokensOut ?? top, sellable: terms.curveSellable, at: new Date().toISOString() };
  costCache = { at: Date.now(), value };
  return value;
}

// A curva puxa os tokens por transferFrom: vender exige approve antes. Para
// COTAR sem gastar, o eth_call recebe um override do slot de allowance do
// token (layout OpenZeppelin: _allowances no slot 1; o namespaced fica de
// reserva). O slot certo e descoberto uma vez por token e fica em cache.
const NS_ERC20 = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [BigInt(keccak256(toHex('openzeppelin.storage.ERC20'))) - 1n]))) & ~0xffn;
const allowanceSlots = new Map();
function allowanceSlot(base, owner, spender) {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, base]));
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]));
}
export async function allowanceOverride({ token, owner, spender, amount }) {
  const key = token.toLowerCase();
  const bases = allowanceSlots.has(key) ? [allowanceSlots.get(key)] : [1n, NS_ERC20 + 1n, 2n, 0n];
  for (const base of bases) {
    const slot = allowanceSlot(base, owner, spender);
    const stateOverride = [{ address: token, stateDiff: [{ slot, value: pad(toHex(amount), { size: 32 }) }] }];
    const seen = await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender], stateOverride }).catch(() => null);
    if (seen === amount) { allowanceSlots.set(key, base); return stateOverride; }
  }
  throw new Error('could not find the allowance storage slot of this token');
}

export async function quoteSell({ curve, token, from, tokensIn }) {
  const stateOverride = await allowanceOverride({ token, owner: from, spender: curve, amount: tokensIn });
  const data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'sell', args: [tokensIn, 0n, from] });
  const res = await client.call({ account: from, to: curve, data, stateOverride });
  return decodeFunctionResult({ abi: CURVE_ABI, functionName: 'sell', data: res.data });
}

// ---------------------------------------------------------------------------
// Erros da pons em linguagem de gente.
const HUMAN = {
  NotWhitelisted: 'pons is only accepting launches from whitelisted wallets right now',
  NotApprovedLauncher: 'pons is only accepting launches from whitelisted wallets right now',
  LaunchFeeNotPaid: 'the launch fee sent does not match what pons charges now',
  NativeValueMismatch: 'the ETH sent does not match launch fee + dev buy',
  LaunchEconomicsMismatch: 'pons changed its launch terms since the quote',
  CreatorTaxTooHigh: 'creator tax is above the maximum pons allows',
  InvalidTokenParams: 'name and ticker cannot be empty',
  LaunchConfigDisabled: 'this pons launch config is disabled',
};

function revertData(error) {
  let e = error;
  for (let i = 0; e && i < 8; i++) {
    if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) return e.data;
    if (e.data && typeof e.data.data === 'string') return e.data.data;
    e = e.cause;
  }
  return null;
}

export function explainRevert(error) {
  const data = revertData(error);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: ALL_ERRORS, data });
      return { code: d.errorName, message: HUMAN[d.errorName] || d.errorName };
    } catch { /* erro desconhecido: cai no texto */ }
  }
  const msg = String(error?.shortMessage || error?.message || error);
  if (/insufficient funds/i.test(msg)) return { code: 'INSUFFICIENT_FUNDS', message: 'the wallet does not hold enough ETH for this transaction' };
  return { code: 'REVERT', message: msg.split('\n')[0].slice(0, 200) };
}

// ---------------------------------------------------------------------------
// A carteira do agente. A chave entra uma vez e nao sai desta funcao; o que
// sai sao cinco acoes com destino fixo.
export function agentWallet(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(CHAIN.rpc, { timeout: 20_000 }) });
  const address = account.address;

  async function confirm(hash) {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 2_000 });
    return { hash, ok: receipt.status === 'success', receipt };
  }

  return {
    address,

    // Lanca o token (com ou sem dev buy). Devolve token, curva e tokens comprados.
    async launch({ terms, params, devBuyWei }) {
      const tx = buildLaunchTx({ params, devBuyWei, recipient: address, launchFee: terms.launchFee });
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
      const r = await confirm(hash);
      const launched = parseEventLogs({ abi: FACTORY_ABI, eventName: 'TokenLaunched', logs: r.receipt.logs, strict: false })[0];
      const buys = parseEventLogs({ abi: CURVE_ABI, eventName: 'CurveBuy', logs: r.receipt.logs, strict: false });
      const tokensOut = buys.reduce((acc, l) => acc + (l.args?.tokensOut ?? 0n), 0n);
      return { ...r, token: launched?.args?.token ?? null, curve: launched?.args?.curve ?? null, tokensOut, block: r.receipt.blockNumber };
    },

    // Vende tokens de volta para a curva do proprio token; o ETH volta para o
    // agente. A curva puxa por transferFrom, entao aprova (so para a curva) antes.
    async sell({ curve, token, tokensIn, minQuoteOut }) {
      const allowed = await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [address, curve] });
      if (allowed < tokensIn) {
        const a = await confirm(await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [curve, tokensIn] }));
        if (!a.ok) return { ...a, step: 'approve' };
      }
      const hash = await wallet.writeContract({ address: curve, abi: CURVE_ABI, functionName: 'sell', args: [tokensIn, minQuoteOut, address] });
      return confirm(hash);
    },

    // Varre as taxas paradas na curva para o escrow (so o deployer consegue).
    async sweep({ curve }) {
      const hash = await wallet.writeContract({ address: curve, abi: CURVE_ABI, functionName: 'sweepFees', args: [0n] });
      return confirm(hash);
    },

    // Saca o que o escrow deve ao agente (ETH nativo).
    async claim() {
      const hash = await wallet.writeContract({ ...escrow, functionName: 'claim' });
      return confirm(hash);
    },

    // Queima: transferencia para o endereco morto, e para mais ninguem.
    async burn({ token, amount }) {
      const hash = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'transfer', args: [DEAD_ADDRESS, amount] });
      return confirm(hash);
    },
  };
}

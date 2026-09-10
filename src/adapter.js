// O adaptador real: liga o motor a chain.js. Sem AGENT_PRIVATE_KEY o motor
// vira observador (le tudo, nao assina nada) e usa AGENT_ADDRESS para ler.
import * as chain from './chain.js';
import { AGENT_PRIVATE_KEY, PONS_TOKEN_URL, ZERO_ADDRESS } from './config.js';

export function realAdapter() {
  const wallet = AGENT_PRIVATE_KEY ? chain.agentWallet(AGENT_PRIVATE_KEY) : null;
  const agent = wallet?.address || (/^0x[0-9a-fA-F]{40}$/.test(process.env.AGENT_ADDRESS || '') ? chain.getAddress(process.env.AGENT_ADDRESS) : ZERO_ADDRESS);
  const signer = (name) => (...args) => {
    if (!wallet) throw new Error(`observer mode: cannot ${name} without AGENT_PRIVATE_KEY`);
    return wallet[name](...args);
  };
  return {
    agent,
    canSign: !!wallet,
    now: () => Date.now(),
    terms: (opts) => chain.protocolTerms(opts),
    canLaunch: () => chain.canLaunch(agent),
    balance: () => chain.getBalance(agent),
    blockNumber: () => chain.blockNumber(),
    curveState: (curve, token) => chain.curveState(curve, token),
    buysBetween: (curve, from, to) => chain.curveBuysBetween(curve, from, to),
    escrowBalance: () => chain.escrowBalance(agent),
    tokenBalance: (token) => chain.tokenBalance(token, agent),
    wholeCurveCost: (terms, opts = {}) => chain.wholeCurveCost({ terms, agent, ...opts }),
    quoteSell: (curve, token, tokensIn) => chain.quoteSell({ curve, token, from: agent, tokensIn }),
    randomSalt: chain.randomSalt,
    launchParams: chain.launchParams,
    simulateLaunch: ({ terms, params, devBuyWei }) => chain.simulateLaunch({ terms, params, devBuyWei, from: agent }),
    explainRevert: chain.explainRevert,
    launchedToken: chain.launchedToken,
    ponsUrl: (token) => PONS_TOKEN_URL.replace('{token}', token),
    launch: signer('launch'),
    sell: signer('sell'),
    sweep: signer('sweep'),
    claim: signer('claim'),
    burn: signer('burn'),
  };
}

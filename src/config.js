// Configuracao do Loop: rede, contratos da pons v2, carteira do agente e as
// regras do jogo. Tudo vem de variavel de ambiente; nada de chave em arquivo.
import path from 'node:path';

export const NETWORKS = {
  mainnet: {
    id: 4663,
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
  },
  testnet: {
    id: 46630,
    name: 'Robinhood Chain Testnet',
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
  },
};

const NETWORK = process.env.PONS_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const NET = NETWORKS[NETWORK];

export const CHAIN = {
  id: NET.id,
  network: NETWORK,
  name: NET.name,
  rpc: process.env.RPC_URL || NET.rpc,
  explorer: NET.explorer,
};

// pons v2 na mainnet (docs.ponsfamily.com/docs/v2). Enderecos verificados no
// Sourcify e usados em lancamentos reais em 10/09/2026.
export const CONTRACTS = {
  factory: process.env.PONS_FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  router: process.env.PONS_LAUNCH_AND_BUY || '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  feeEscrow: process.env.PONS_FEE_ESCROW || '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
};

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const str = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? String(process.env[k]) : d);

// O token que nasce a cada volta. Mesmo nome, mesmo ticker, sempre.
export const TOKEN = {
  name: str('LOOP_NAME', 'Loop'),
  symbol: str('LOOP_SYMBOL', 'LOOP').replace(/^\$/, '').toUpperCase(),
  description: str('LOOP_DESCRIPTION', ''),
  logo: str('LOOP_LOGO', ''),
  website: str('LOOP_WEBSITE', ''),
  twitter: str('LOOP_TWITTER', ''),
  telegram: str('LOOP_TELEGRAM', ''),
  creatorTaxBps: num('CREATOR_TAX_BPS', 200),
  launchConfigId: BigInt(str('PONS_LAUNCH_CONFIG_ID', '0')),
};

// As regras do jogo. Horas e porcentagens; o motor le isto a cada ciclo.
export const RULES = {
  tickSec: num('TICK_SEC', 60),
  // Mortes automaticas: 0 = desligada. Padrao TUDO desligado (decisao do Michel,
  // 11/09/2026): ele olha se so tem bot segurando e encerra o loop pelo botao.
  // X horas sem nenhuma compra de terceiros E mcap abaixo de (100 - drop)% do pico.
  deathIdleHours: num('DEATH_IDLE_HOURS', 0),
  deathDropPct: num('DEATH_DROP_PCT', 80),
  // Morte por idade, aconteca o que acontecer.
  maxLifeHours: num('MAX_LIFE_HOURS', 0),
  // Natimorto: ninguem alem do agente comprou em X horas.
  stillbornHours: num('STILLBORN_HOURS', 0),
  // Pausa entre a morte e o proximo nascimento (para o mundo ver).
  rebirthDelayMin: num('REBIRTH_DELAY_MIN', 15),
  // ETH que nunca entra no pote (gas das proximas transacoes).
  gasReserveEth: str('GAS_RESERVE_ETH', '0.003'),
  // Menor dev buy que vale um lancamento.
  minDevBuyEth: str('MIN_DEV_BUY_ETH', '0.001'),
  // Folga acima do custo da curva inteira no lancamento final (o router devolve a sobra).
  finalMarginPct: num('FINAL_MARGIN_PCT', 2),
  // Tolerancia de preco na venda da posicao morta.
  sellSlippagePct: num('SELL_SLIPPAGE_PCT', 3),
  // Compra de terceiros que merece um post.
  whaleEth: str('WHALE_ETH', '0.05'),
  // Silencio noturno para posts (UTC), ex. "22-8". Vazio = sem silencio.
  quietHours: str('QUIET_HOURS', ''),
};

// Carteira do agente: chave so por env. Sem chave, o motor roda em modo
// observador (le a chain, nao assina nada).
// Aceita com ou sem 0x (o MetaMask exporta sem).
const rawKey = String(process.env.AGENT_PRIVATE_KEY || '').trim().replace(/^0x/i, '');
export const AGENT_PRIVATE_KEY = /^[0-9a-fA-F]{64}$/.test(rawKey) ? `0x${rawKey.toLowerCase()}` : null;

// Quem autoriza a queima final e aperta os botoes internos: o token de admin,
// digitado uma vez na pagina. Sem env, o servidor gera um e grava em DATA_DIR.
export const ADMIN_TOKEN = str('ADMIN_TOKEN', '') || null;

export const PORT = num('PORT', 8437);
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// Com CANONICAL_HOST, paginas pedidas por outro host (railway.app, www) redirecionam
// para o dominio proprio. /api nao redireciona.
export const CANONICAL_HOST = str('CANONICAL_HOST', '').toLowerCase() || null;
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const PONS_TOKEN_URL = process.env.PONS_TOKEN_URL || 'https://www.ponsfamily.com/launchpad/{token}';
export const APP_NAME = 'Loop';
export const VERSION = '0.1.0';

// Voz e canais (todos opcionais).
export const VOICE = {
  model: str('AGENT_MODEL', 'claude-sonnet-5'),
  vibe: str('AGENT_VIBE', 'calm, matter-of-fact, a little poetic about death and rebirth'),
};
export const X_CREDS = {
  apiKey: str('X_API_KEY', ''), apiSecret: str('X_API_SECRET', ''),
  accessToken: str('X_ACCESS_TOKEN', ''), accessSecret: str('X_ACCESS_SECRET', ''),
};
export const TELEGRAM = { botToken: str('TELEGRAM_BOT_TOKEN', ''), chatId: str('TELEGRAM_CHAT_ID', '') };
export const LINKS = { x: str('LINK_X', ''), telegram: str('LINK_TELEGRAM', '') };

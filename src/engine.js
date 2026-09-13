// O motor do Loop. Um ciclo por minuto:
//   sem loop vivo  -> pote = saldo - reserva - taxa; se cobre a curva inteira,
//                     pede autorizacao; senao lanca o proximo com o pote todo.
//   com loop vivo  -> acompanha compras, pico e graduacao; aplica a regra de
//                     morte; ao morrer vende a posicao, varre e saca as taxas.
//   final          -> so com autorizacao do admin: lanca comprando a curva
//                     inteira e queima tudo que recebeu. Acabou.
// A chain e o relogio entram por um adaptador (adapter) para as provas rodarem
// sem rede. O adaptador real esta em adapter.js.
import { RULES, TOKEN, PUBLIC_URL } from './config.js';
import { parseEther, formatEther, formatUnits } from 'viem';

const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const eth = (wei) => formatEther(wei);
const fmtTokens = (wei) => formatUnits(wei, 18);
const short = (e) => String(e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 160);

// Conserto de uma vez so: o loop 1 nasceu antes de existir o marco de saldo, e
// por isso so contou as fees do escrow (0,0032) em vez das que cairam direto na
// carteira. Valor reconstruido pela aritmetica do saldo on-chain em 13/09/2026:
// saldo final - venda - claim - saldo no nascimento. Loops novos medem sozinhos.
const BACKFILL_FEES = { '0xbfbd1fe7bb87e4e727563e7f7bdf0cdce5353d87': '2.113878669949326248' };
// O loop 2 graduou e a posicao foi vendida no pool na mao, em 13/09/2026, antes
// de existir o botao. Numeros lidos da chain: 1,614968… ETH entraram e a
// carteira ficou com zero token do loop 2.
const BACKFILL_SALE = {
  '0xf01439e2a3f5f032db9b19c1e7fbcd985d841bd0': {
    soldEth: '1.614968272218709253',
    balanceAfterEth: '2.201988308446399962',
    tokensAfterWei: '0',
  },
};
// Menor saque que vale uma transacao (o gas de um claim e ~0,000003 ETH).
const MIN_CLAIM = parseEther('0.0005');

export class Engine {
  constructor({ adapter, state, save, rules = RULES, publish = null, log = console }) {
    this.adapter = adapter;
    this.state = state;
    this.save = save || (() => {});
    this.rules = rules;
    this.publish = publish;           // async (event, text) => { tweetId, telegramId } | null
    this.console = log;
    this.busy = false;
    this.backfill();
  }

  backfill() {
    const s = this.state;
    let changed = false;
    for (const l of s.loops || []) {
      const right = BACKFILL_FEES[String(l.token).toLowerCase()];
      if (!right || l.feesBackfilled || l.balanceAtBirthEth) continue;
      s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth || '0') - parseEther(l.feesEth || '0') + parseEther(right));
      l.feesEth = right;
      l.feesBackfilled = true;
      changed = true;
    }
    for (const l of s.loops || []) {
      const sale = BACKFILL_SALE[String(l.token).toLowerCase()];
      if (!sale || l.saleBackfilled) continue;
      s.stats.soldTotalEth = eth(parseEther(s.stats.soldTotalEth || '0') - parseEther(l.soldEth || '0') + parseEther(sale.soldEth));
      Object.assign(l, sale);
      l.saleBackfilled = true;
      changed = true;
    }
    // Loop encerrado antes de existir o acerto de contas: zera e deixa o
    // settleLast recontar tudo pelo saldo, do nascimento ate agora.
    const last = s.loops[s.loops.length - 1];
    if (last && last.status !== 'live' && !last.balanceAfterEth && last.balanceAtBirthEth) {
      s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth || '0') - parseEther(last.feesEth || '0'));
      last.feesEth = '0';
      last.balanceAfterEth = last.balanceAtBirthEth;
      changed = true;
    }
    if (changed) this.save(s);
  }

  now() { return this.adapter.now ? this.adapter.now() : Date.now(); }
  get agent() { return this.adapter.agent; }
  liveLoop() { return this.state.loops.find((l) => l.status === 'live') || null; }
  lastLoop() { return this.state.loops[this.state.loops.length - 1] || null; }

  // Reserva e menor dev buy, em wei.
  reserveWei() { return parseEther(String(this.rules.gasReserveEth)); }
  minDevBuyWei() { return parseEther(String(this.rules.minDevBuyEth)); }

  // -------------------------------------------------------------------------
  // Diario e posts.
  note(kind, text, extra = {}) {
    this.state.log.unshift({ at: iso(this.now()), kind, text, ...extra });
    this.state.log = this.state.log.slice(0, 300);
    this.console.log(`[loop] ${kind}: ${text}`);
  }

  async post(event, context = {}) {
    const entry = { at: iso(this.now()), kind: event.kind, loop: event.n ?? null, text: null, generated: false, tweetId: null, telegramId: null };
    try {
      const { say } = await import('./voice.js');
      const v = await say(event, context);
      entry.text = v.text; entry.generated = v.generated;
    } catch (e) {
      entry.text = `${TOKEN.symbol}: ${event.kind}`;
    }
    this.state.posts.unshift(entry);
    this.state.posts = this.state.posts.slice(0, 200);
    if (this.publish) {
      try {
        const r = await this.publish(event, entry.text);
        if (r) { entry.tweetId = r.tweetId ?? null; entry.telegramId = r.telegramId ?? null; }
      } catch (e) { this.note('publish_error', short(e)); }
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // O ciclo.
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const s = this.state;
    s.lastTickAt = iso(this.now());
    try {
      if (s.paused) return;
      const live = this.liveLoop();
      if (live) await this.watch(live);
      else await this.next();
      s.lastError = null;
    } catch (e) {
      s.lastError = { at: iso(this.now()), message: short(e) };
      this.note('error', short(e));
    } finally {
      this.save(s);
      this.busy = false;
    }
  }

  // Loop vivo: compras, pico, graduacao, regra de morte.
  async watch(loop) {
    const s = this.state;
    const a = this.adapter;
    const cs = await a.curveState(loop.curve, loop.token);
    const latest = await a.blockNumber();
    const from = s.lastScanBlock !== null ? BigInt(s.lastScanBlock) + 1n : BigInt(loop.bornBlock || 0);
    if (latest >= from) {
      const buys = await a.buysBetween(loop.curve, from, latest);
      const whale = parseEther(String(this.rules.whaleEth));
      for (const b of buys) {
        if (String(b.recipient).toLowerCase() === String(this.agent || '').toLowerCase()) continue;
        loop.buys += 1;
        loop.lastBuyAt = iso(this.now());
        loop.othersEth = eth(parseEther(loop.othersEth || '0') + b.quoteIn);
        s.stats.buysTotal += 1;
        if (b.quoteIn > parseEther(loop.biggestBuyEth || '0')) loop.biggestBuyEth = eth(b.quoteIn);
        if (b.quoteIn >= whale) await this.post({ kind: 'whale', n: loop.n, eth: eth(b.quoteIn) }, this.context(loop, cs));
      }
      s.lastScanBlock = latest.toString();
    }
    // Depois de graduar a curva fica zerada (a liquidez foi para o pool), entao
    // nao sobrescreve os numeros da vida do loop com zeros.
    if (!cs.graduated) {
      loop.mcapEth = cs.mcapEth;
      loop.priceEth = cs.priceEth;
      loop.raisedEth = cs.raisedEth;
      loop.graduationPct = Number(cs.realQuote * 10_000n / (await a.terms()).graduationThreshold) / 100;
    }
    if (cs.mcapEth > (loop.peakMcapEth || 0)) { loop.peakMcapEth = cs.mcapEth; loop.peakAt = iso(this.now()); }
    const escrowBal = await a.escrowBalance();
    loop.pendingFeesEth = eth(cs.unswept + escrowBal);
    loop.seenAt = iso(this.now());

    if (cs.graduated || cs.readyToGraduate) return this.graduate(loop, cs);
    const reason = this.deathReason(loop);
    if (reason) return this.die(loop, reason, cs);
    s.phase = 'live';
  }

  // Regras automaticas de morte. Cada uma com 0 esta DESLIGADA; o padrao e tudo
  // desligado: o Michel olha a curva e encerra o loop pelo botao.
  deathReason(loop) {
    const r = this.rules;
    const now = this.now();
    const born = Date.parse(loop.bornAt);
    const ageH = (now - born) / H;
    const idleH = (now - (loop.lastBuyAt ? Date.parse(loop.lastBuyAt) : born)) / H;
    if (r.maxLifeHours > 0 && ageH >= r.maxLifeHours) return 'max life reached';
    if (r.stillbornHours > 0 && loop.buys === 0 && ageH >= r.stillbornHours) return 'stillborn';
    if (r.deathIdleHours > 0) {
      const floor = (loop.peakMcapEth || 0) * (1 - r.deathDropPct / 100);
      if (idleH >= r.deathIdleHours && (loop.mcapEth || 0) <= floor) return 'no buys and mcap below the floor';
    }
    return null;
  }

  context(loop, cs) {
    return {
      loop: loop.n, mcapEth: cs?.mcapEth ?? loop.mcapEth, peakMcapEth: loop.peakMcapEth, buys: loop.buys,
      raisedEth: cs?.raisedEth ?? loop.raisedEth, aliveHours: ((this.now() - Date.parse(loop.bornAt)) / H).toFixed(1),
    };
  }

  // Morte: vende a posicao de volta para a curva, varre e saca as taxas.
  async die(loop, reason, cs = null) {
    const s = this.state;
    const a = this.adapter;
    s.phase = 'dying';
    this.save(s);
    this.note('dying', `loop #${loop.n}: ${reason}`);
    if (!cs) cs = await a.curveState(loop.curve, loop.token);
    const txs = [];
    let soldWei = 0n;
    const directFees = await this.directFees(loop);

    // 1) venda da posicao (so na curva; depois da graduacao nao ha rota)
    const held = await a.tokenBalance(loop.token);
    if (held > 0n && !cs.graduated && !cs.readyToGraduate) {
      try {
        const quote = await a.quoteSell(loop.curve, loop.token, held);
        const minOut = (quote * BigInt(100 - this.rules.sellSlippagePct)) / 100n;
        const r = await a.sell({ curve: loop.curve, token: loop.token, tokensIn: held, minQuoteOut: minOut });
        txs.push({ label: 'sell', hash: r.hash, ok: r.ok });
        if (r.ok) soldWei = quote; else this.note('error', `sell reverted on loop #${loop.n}`);
      } catch (e) { this.note('error', `sell failed on loop #${loop.n}: ${short(e)}`); }
    }

    // 2) taxas: varre a curva (deployer) e saca o escrow
    const fees = await this.collect(loop, cs, txs);

    loop.status = 'dead';
    loop.diedAt = iso(this.now());
    loop.deathReason = reason;
    loop.soldEth = eth(soldWei);
    loop.feesEth = eth(fees + directFees);
    loop.balanceAfterEth = eth(await a.balance().catch(() => 0n));
    loop.tokensAfterWei = (await a.tokenBalance(loop.token).catch(() => 0n)).toString();
    loop.txs = [...(loop.txs || []), ...txs];
    s.stats.loopsDead += 1;
    s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth) + fees + directFees);
    s.stats.soldTotalEth = eth(parseEther(s.stats.soldTotalEth) + soldWei);
    s.restUntil = iso(this.now() + this.rules.rebirthDelayMin * 60_000);
    s.phase = 'resting';
    this.save(s);
    const pot = await this.potWei();
    await this.post({
      kind: reason === 'stillborn' ? 'stillborn' : 'died', n: loop.n, reason, hours: this.rules.stillbornHours,
      peakMcapEth: Number(loop.peakMcapEth || 0).toFixed(4), buys: loop.buys, feesEth: loop.feesEth, soldEth: loop.soldEth, potEth: eth(pot > 0n ? pot : 0n),
    }, this.context(loop, cs));
  }

  // Fees que caíram direto na carteira durante a vida do loop. Mede pelo saldo,
  // porque nao ha evento por trade. Entre o nascimento e a morte a carteira so
  // recebe fee e so gasta gas, entao a diferenca e o que ela ganhou (levemente
  // subestimada pelo gas). Loops antigos, sem marco, contam zero aqui.
  async directFees(loop) {
    if (!loop.balanceAtBirthEth) return 0n;
    const now = await this.adapter.balance().catch(() => 0n);
    const born = parseEther(loop.balanceAtBirthEth);
    return now > born ? now - born : 0n;
  }

  // Entre loops: a pons continua varrendo as taxas do pool do token que graduou
  // para o escrow. Recolhe sozinho, senao esse dinheiro fica de fora do pote.
  async claimEscrow() {
    try {
      const owed = await this.adapter.escrowBalance();
      if (owed < MIN_CLAIM) return 0n;
      const r = await this.adapter.claim();
      if (!r?.ok) return 0n;
      this.note('claim', `claimed ${eth(owed)} ETH from the escrow between loops`);
      return owed;
    } catch (e) { this.note('error', `claim between loops: ${short(e)}`); return 0n; }
  }

  // As fees do loop que acabou continuam pingando depois da morte dele (a pons
  // paga parte no fim). Enquanto nenhum loop novo nasce, o que entra na carteira
  // pertence ao ultimo loop: acerta a conta dele a cada ciclo.
  async settleLast() {
    const s = this.state;
    const last = s.loops[s.loops.length - 1];
    if (!last || last.status === 'live' || !last.balanceAfterEth) return;
    const now = await this.adapter.balance().catch(() => null);
    if (now === null) return;

    // Marca quantos tokens do loop morto a carteira ainda tem. Se esse numero
    // cair, alguem vendeu a posicao (inclusive na mao, pelo pool da Uniswap
    // depois da graduacao) e o ETH que entrou e venda, nao taxa.
    let sold = false;
    const held = await this.adapter.tokenBalance(last.token).catch(() => null);
    if (held !== null) {
      if (last.tokensAfterWei === undefined) last.tokensAfterWei = held.toString();
      else if (held < BigInt(last.tokensAfterWei)) { sold = true; last.tokensAfterWei = held.toString(); }
    }

    const before = parseEther(last.balanceAfterEth);
    if (now <= before) return;
    const delta = now - before;
    if (sold) {
      last.soldEth = eth(parseEther(last.soldEth || '0') + delta);
      s.stats.soldTotalEth = eth(parseEther(s.stats.soldTotalEth || '0') + delta);
      this.note('sold', `position of loop #${last.n} sold: ${eth(delta)} ETH into the pot`);
    } else {
      last.feesEth = eth(parseEther(last.feesEth || '0') + delta);
      s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth || '0') + delta);
    }
    last.balanceAfterEth = eth(now);
  }

  async collect(loop, cs, txs) {
    const a = this.adapter;
    let fees = 0n;
    try {
      if (!cs.graduated && !cs.buybackEnabled && String(cs.deployer).toLowerCase() === String(this.agent || '').toLowerCase() && cs.unswept > 0n) {
        const r = await a.sweep({ curve: loop.curve });
        txs.push({ label: 'sweep', hash: r.hash, ok: r.ok });
      }
    } catch (e) { this.note('error', `sweep failed on loop #${loop.n}: ${short(e)}`); }
    try {
      const owed = await a.escrowBalance();
      if (owed > 0n) {
        const r = await a.claim();
        txs.push({ label: 'claim', hash: r.hash, ok: r.ok });
        if (r.ok) fees = owed;
      }
    } catch (e) { this.note('error', `claim failed on loop #${loop.n}: ${short(e)}`); }
    return fees;
  }

  // Graduou: a posicao fica presa no pool; as taxas continuam pelo escrow.
  async graduate(loop, cs) {
    const s = this.state;
    const txs = [];
    const directFees = await this.directFees(loop);
    const fees = await this.collect(loop, cs, txs);
    loop.status = 'graduated';
    loop.diedAt = iso(this.now());
    loop.deathReason = 'graduated';
    loop.soldEth = '0';
    loop.graduationPct = 100;
    loop.migrated = true;
    loop.feesEth = eth(fees + directFees);
    loop.balanceAfterEth = eth(await this.adapter.balance().catch(() => 0n));
    loop.tokensAfterWei = (await this.adapter.tokenBalance(loop.token).catch(() => 0n)).toString();
    loop.txs = [...(loop.txs || []), ...txs];
    s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth) + fees + directFees);
    s.restUntil = iso(this.now() + this.rules.rebirthDelayMin * 60_000);
    s.phase = 'resting';
    this.save(s);
    await this.post({ kind: 'graduated', n: loop.n, feesEth: loop.feesEth, sold: false, positionLockedInPool: loop.tokensBought }, this.context(loop, cs));
  }

  // Pote: o que sobra do saldo depois da reserva de gas e da taxa da pons.
  async potWei() {
    const terms = await this.adapter.terms();
    const bal = await this.adapter.balance();
    return bal - this.reserveWei() - terms.launchFee;
  }

  // Sem loop vivo: descansa, pede gas, pede autorizacao ou lanca.
  async next() {
    const s = this.state;
    const a = this.adapter;
    if (s.phase === 'final_done') return this.afterFinal();
    if (s.pendingLaunch) { const rec = await this.recoverPending(); if (rec) return; }
    if (s.phase === 'awaiting_authorization') {
      if (s.final?.authorizedAt) return this.finalLaunch();
      return;
    }
    if (!a.canSign) { s.phase = 'observer'; return; }
    // Dinheiro primeiro: recolhe o escrow e acerta a conta do ultimo loop mesmo
    // durante o descanso, senao o pote mostra menos do que a carteira tem.
    await this.claimEscrow();
    await this.settleLast();
    if (!this.rules.manualLaunch && s.restUntil && this.now() < Date.parse(s.restUntil)) { s.phase = 'resting'; return; }
    if (s.retryAfter && this.now() < Date.parse(s.retryAfter)) return;

    const terms = await a.terms();
    if (!terms.launchEnabled && !(await a.canLaunch())) { s.phase = 'blocked'; this.noteOnce('blocked', 'pons is not accepting launches from this wallet right now'); return; }
    const bal = await a.balance();
    const pot = bal - this.reserveWei() - terms.launchFee;
    if (pot < this.minDevBuyWei()) {
      s.phase = 'needs_gas';
      const needed = this.reserveWei() + terms.launchFee + this.minDevBuyWei();
      await this.postOnce('needs_gas', { kind: 'needs_gas', balanceEth: eth(bal), neededEth: eth(needed), agent: this.agent }, 3600_000);
      return;
    }
    // Modo manual: pote pronto, espera o criador apertar "Launch next loop".
    if (this.rules.manualLaunch && !s.launchRequested) {
      s.phase = 'ready';
      await this.postOnce('ready', { kind: 'ready', n: s.loops.length + 1, potEth: eth(pot) }, 6 * 3600_000);
      return;
    }
    // A curva inteira custa mais que o limiar de graduacao; so vale medir (24
    // simulacoes seguidas, a RPC publica reclama) quando o pote chega perto.
    if (pot >= (terms.graduationThreshold * 9n) / 10n) {
      const cost = await a.wholeCurveCost(terms);
      s.curveCost = { eth: eth(cost.wei), tokens: fmtTokens(cost.tokensOut), at: cost.at, measured: true };
      if (pot >= cost.wei) return this.requestFinal(pot, cost);
    } else if (!s.curveCost) {
      s.curveCost = { eth: String(this.rules.finalCostEstimateEth || '4.75'), tokens: fmtTokens(terms.curveSellable), at: iso(this.now()), measured: false };
    }
    // Com teto, o loop nasce com uma semente e o resto do pote fica guardado
    // para o fim; sem teto, nasce com tudo.
    const cap = parseEther(String(this.rules.maxLaunchEth || '0'));
    await this.launch(cap > 0n && pot > cap ? cap : pot, terms, { final: false });
  }

  noteOnce(kind, text, everyMs = 3600_000) {
    const last = this.state.log.find((l) => l.kind === kind);
    if (last && this.now() - Date.parse(last.at) < everyMs) return;
    this.note(kind, text);
  }

  async postOnce(kind, event, everyMs) {
    const last = this.state.posts.find((p) => p.kind === kind);
    if (last && this.now() - Date.parse(last.at) < everyMs) return;
    await this.post(event);
  }

  // Lancamento (normal ou final). Simula antes; grava o previsto antes de
  // assinar para poder recuperar se o processo cair no meio.
  async launch(devBuyWei, terms, { final }) {
    const s = this.state;
    const a = this.adapter;
    const n = s.loops.length + 1;
    const salt = a.randomSalt();
    const description = (TOKEN.description || `${TOKEN.name} #${n}. Born, dies, and is born again from its own fees.`).replace('{n}', String(n)) + (PUBLIC_URL ? ` ${PUBLIC_URL}` : '');
    const params = a.launchParams({ terms, agent: this.agent, salt, description });
    let predicted;
    try {
      predicted = await a.simulateLaunch({ terms, params, devBuyWei });
    } catch (e) {
      const r = a.explainRevert ? a.explainRevert(e) : { message: short(e) };
      s.retryAfter = iso(this.now() + 10 * 60_000);
      s.phase = 'error';
      this.note('error', `launch simulation failed: ${r.message}`);
      return null;
    }
    s.pendingLaunch = { n, salt, token: predicted.token, curve: predicted.curve, devBuyEth: eth(devBuyWei), final, at: iso(this.now()) };
    s.phase = final ? 'final_launching' : 'launching';
    this.save(s);

    let r;
    try {
      r = await a.launch({ terms, params, devBuyWei });
    } catch (e) {
      // Nao sabemos se a transacao entrou: a recuperacao decide no proximo ciclo.
      this.note('error', `launch send failed: ${short(e)}`);
      s.retryAfter = iso(this.now() + 2 * 60_000);
      return null;
    }
    if (!r.ok) {
      s.pendingLaunch = null;
      s.retryAfter = iso(this.now() + 10 * 60_000);
      s.phase = 'error';
      this.note('error', `launch reverted (${r.hash})`);
      return null;
    }
    const loop = this.newLoop({ n, token: r.token || predicted.token, curve: r.curve || predicted.curve, hash: r.hash, block: r.block, devBuyWei, tokensOut: r.tokensOut, final });
    // Marco zero do saldo: a pons paga a maior parte da creator tax DIRETO na
    // carteira a cada trade, nao so no escrow. Entao as fees do loop sao
    // (saldo na morte - saldo no nascimento) + o que o escrow pagou no fim.
    loop.balanceAtBirthEth = eth(await a.balance().catch(() => 0n));
    s.pendingLaunch = null;
    s.retryAfter = null;
    s.restUntil = null;
    s.launchRequested = false;
    s.phase = final ? 'final_launching' : 'live';
    this.save(s);
    if (!final) {
      const prev = s.loops[s.loops.length - 2];
      await this.post({ kind: 'born', n, devBuyEth: loop.devBuyEth, potEth: loop.devBuyEth, prevFeesEth: prev?.feesEth ?? null }, { token: loop.token, pons: a.ponsUrl ? a.ponsUrl(loop.token) : null });
    }
    return loop;
  }

  newLoop({ n, token, curve, hash, block, devBuyWei, tokensOut, final }) {
    const loop = {
      n, token, curve, launchTx: hash, bornAt: iso(this.now()), bornBlock: block ? block.toString() : null,
      devBuyEth: eth(devBuyWei), tokensBought: fmtTokens(tokensOut ?? 0n),
      status: final ? 'final' : 'live', buys: 0, lastBuyAt: null, othersEth: '0', biggestBuyEth: '0',
      mcapEth: 0, peakMcapEth: 0, peakAt: null, priceEth: 0, raisedEth: '0', graduationPct: 0, pendingFeesEth: '0',
      diedAt: null, deathReason: null, soldEth: null, feesEth: null, txs: [],
    };
    this.state.loops.push(loop);
    this.state.stats.loopsBorn += 1;
    this.state.lastScanBlock = block ? block.toString() : null;
    return loop;
  }

  // O processo caiu depois de assinar? Se o token previsto existe, o loop
  // nasceu: recupera. Se nao existe e ja passou tempo, esquece.
  async recoverPending() {
    const s = this.state;
    const p = s.pendingLaunch;
    const info = await this.adapter.launchedToken(p.token);
    if (info?.exists) {
      const held = await this.adapter.tokenBalance(p.token);
      const block = await this.adapter.blockNumber();
      const loop = this.newLoop({ n: p.n, token: p.token, curve: info.curve || p.curve, hash: null, block, devBuyWei: parseEther(p.devBuyEth), tokensOut: held, final: p.final });
      loop.bornAt = p.at;
      s.pendingLaunch = null;
      s.phase = p.final ? 'final_launching' : 'live';
      this.note('recovered', `loop #${p.n} was on-chain after a restart; resumed`);
      if (p.final) await this.finalBurn(loop);
      return true;
    }
    if (this.now() - Date.parse(p.at) > 10 * 60_000) { s.pendingLaunch = null; this.note('recovered', `pending launch #${p.n} never landed; discarded`); }
    return false;
  }

  // -------------------------------------------------------------------------
  // O fim: pedir, autorizar, lancar comprando a curva inteira, queimar.
  async requestFinal(pot, cost) {
    const s = this.state;
    if (s.final?.requestedAt && !s.final.authorizedAt && s.phase === 'awaiting_authorization') return;
    s.final = { requestedAt: iso(this.now()), potEth: eth(pot), curveCostEth: eth(cost.wei), curveTokens: fmtTokens(cost.tokensOut), authorizedAt: null, authorizedVia: null, launchTx: null, burnTx: null, burnedTokens: null };
    s.phase = 'awaiting_authorization';
    this.save(s);
    await this.post({ kind: 'final_requested', potEth: s.final.potEth, curveCostEth: s.final.curveCostEth });
  }

  authorizeFinal(via = 'admin') {
    const s = this.state;
    if (s.phase !== 'awaiting_authorization' || !s.final) throw new Error('nothing to authorize: the agent has not asked for the final burn');
    if (s.final.authorizedAt) return s.final;
    s.final.authorizedAt = iso(this.now());
    s.final.authorizedVia = via;
    this.note('authorized', `final burn authorized via ${via}`);
    this.save(s);
    return s.final;
  }

  async finalLaunch() {
    const s = this.state;
    const a = this.adapter;
    const terms = await a.terms();
    const cost = await a.wholeCurveCost(terms, { fresh: true });
    const bal = await a.balance();
    const pot = bal - this.reserveWei() - terms.launchFee;
    if (pot < cost.wei) {
      // O custo subiu ou o saldo caiu: volta a esperar e avisa uma vez por hora.
      s.final.authorizedAt = null;
      s.phase = 'awaiting_authorization';
      this.noteOnce('final_short', `final buy needs ${eth(cost.wei)} ETH, pot is ${eth(pot)} ETH; waiting`);
      return;
    }
    const margin = (cost.wei * BigInt(100 + this.rules.finalMarginPct)) / 100n;
    const devBuy = margin < pot ? margin : pot;
    const loop = await this.launch(devBuy, terms, { final: true });
    if (!loop) return;
    s.final.launchTx = loop.launchTx;
    await this.post({ kind: 'final_launched', n: loop.n, tokens: loop.tokensBought });
    await this.finalBurn(loop);
  }

  async finalBurn(loop) {
    const s = this.state;
    const held = await this.adapter.tokenBalance(loop.token);
    if (held > 0n) {
      const r = await this.adapter.burn({ token: loop.token, amount: held });
      loop.txs.push({ label: 'burn', hash: r.hash, ok: r.ok });
      if (!r.ok) { this.note('error', `burn reverted (${r.hash}); will retry`); s.retryAfter = iso(this.now() + 5 * 60_000); return; }
      s.final.burnTx = r.hash;
    }
    s.final.burnedTokens = fmtTokens(held);
    s.final.doneAt = iso(this.now());
    loop.status = 'burned';
    loop.diedAt = iso(this.now());
    loop.deathReason = 'burned';
    s.phase = 'final_done';
    this.save(s);
    await this.post({ kind: 'burned', n: loop.n, tokens: s.final.burnedTokens });
  }

  // Depois do fim, so recolhe o que ainda pingar no escrow (taxas do pool).
  async afterFinal() {
    const owed = await this.adapter.escrowBalance().catch(() => 0n);
    if (owed > 0n && this.adapter.canSign) {
      const r = await this.adapter.claim();
      this.note('claim', `claimed ${eth(owed)} ETH after the end (${r.hash})`);
    }
  }

  // -------------------------------------------------------------------------
  // Botoes internos.
  // "End loop": vende a posicao, varre e saca. No modo manual fica em 'ready'
  // esperando "Launch next loop"; no automatico o proximo ciclo lanca.
  async kill(reason = 'the loop ran its course') {
    const loop = this.liveLoop();
    if (!loop) throw new Error('no live loop to end');
    if (this.busy) throw new Error('busy; try again in a moment');
    this.busy = true;
    try {
      await this.die(loop, reason);
      this.state.restUntil = null;
    } finally { this.save(this.state); this.busy = false; }
    return loop;
  }

  // "Launch next loop": autoriza UM lancamento (o proximo ciclo executa).
  requestLaunch() {
    const s = this.state;
    if (this.liveLoop()) throw new Error('a loop is still live; end it first');
    if (s.phase === 'final_done') throw new Error('the loop is over: the final burn already happened');
    if (s.phase === 'awaiting_authorization') throw new Error('the pot covers the whole curve: use "Authorize the final burn" instead');
    s.launchRequested = true;
    s.restUntil = null;
    s.retryAfter = null;
    this.note('launch_requested', 'next launch authorized by the creator');
    this.save(s);
    return { launchRequested: true };
  }

  // Vende no pool da Uniswap o que sobrou de um loop que graduou. A curva desse
  // loop esta fechada, entao a venda normal nao serve. So pelo painel.
  async sellLeftover({ slippagePct = 5 } = {}) {
    const s = this.state;
    const a = this.adapter;
    if (!a.canSign) throw new Error('observer mode: no key to sign with');
    if (this.busy) throw new Error('busy; try again in a moment');
    if (this.liveLoop()) throw new Error('a loop is still live; end it first');
    const loop = [...s.loops].reverse().find((l) => l.status !== 'live');
    if (!loop) throw new Error('no finished loop to sell');
    const held = await a.tokenBalance(loop.token);
    if (held === 0n) throw new Error(`loop #${loop.n} has nothing left to sell`);
    this.busy = true;
    try {
      const deadline = BigInt(Math.floor(this.now() / 1000) + 900);
      const approvals = await a.approveForPool({ token: loop.token, amount: held });
      loop.txs = [...(loop.txs || []), ...approvals];
      const { poolKey, out } = await a.quotePoolSell({ token: loop.token, amountIn: held, deadline });
      if (out <= 0n) throw new Error('the pool would pay nothing for this position');
      const minOut = (out * BigInt(100 - slippagePct)) / 100n;
      const r = await a.sellOnPool({ poolKey, amountIn: held, minOut, deadline });
      loop.txs.push({ label: 'pool sell', hash: r.hash, ok: r.ok });
      if (!r.ok) throw new Error(`the pool swap reverted (${r.hash})`);
      this.note('sold', `sold what was left of loop #${loop.n} on the pool, about ${eth(out)} ETH`);
      this.save(s);
      await this.settleLast();
      return { loop: loop.n, tokens: fmtTokens(held), expectedEth: eth(out) };
    } finally { this.save(s); this.busy = false; }
  }

  // Quanto vale, hoje, a sobra do ultimo loop encerrado (sem gastar nada).
  async leftover() {
    const s = this.state;
    const loop = [...s.loops].reverse().find((l) => l.status !== 'live');
    if (!loop || !this.adapter.tokenBalance) return null;
    const held = await this.adapter.tokenBalance(loop.token).catch(() => 0n);
    if (!held || held === 0n) return null;
    return { loop: loop.n, token: loop.token, tokens: fmtTokens(held), graduated: loop.status === 'graduated' };
  }

  skipRest() { this.state.restUntil = null; this.state.retryAfter = null; this.save(this.state); }
  pause() { this.state.paused = true; this.note('paused', 'paused by admin'); this.save(this.state); }
  resume() { this.state.paused = false; this.note('resumed', 'resumed by admin'); this.save(this.state); }

  // -------------------------------------------------------------------------
  // O que a pagina ve (sem nada secreto; o estado nao guarda segredo nenhum).
  view({ ethUsd = null, balanceWei = null, terms = null } = {}) {
    const s = this.state;
    const live = this.liveLoop();
    const reserve = this.reserveWei();
    const fee = terms?.launchFee ?? 0n;
    const pot = balanceWei !== null ? balanceWei - reserve - fee : null;
    return {
      name: TOKEN.name, symbol: TOKEN.symbol, agent: this.agent, canSign: !!this.adapter.canSign,
      phase: s.phase, paused: s.paused, restUntil: s.restUntil, lastTickAt: s.lastTickAt, lastError: s.lastError,
      launchRequested: !!s.launchRequested,
      rules: {
        deathIdleHours: this.rules.deathIdleHours, deathDropPct: this.rules.deathDropPct, maxLifeHours: this.rules.maxLifeHours,
        stillbornHours: this.rules.stillbornHours, rebirthDelayMin: this.rules.rebirthDelayMin, gasReserveEth: this.rules.gasReserveEth,
        creatorTaxPct: TOKEN.creatorTaxBps / 100, manualLaunch: !!this.rules.manualLaunch,
        maxLaunchEth: this.rules.maxLaunchEth || '0',
      },
      ethUsd,
      balanceEth: balanceWei !== null ? eth(balanceWei) : null,
      potEth: pot !== null ? eth(pot > 0n ? pot : 0n) : null,
      curveCost: s.curveCost,
      pendingLaunch: s.pendingLaunch || null,
      retryAfter: s.retryAfter || null,
      final: s.final,
      stats: s.stats,
      live,
      loops: [...s.loops].reverse(),
      posts: s.posts.slice(0, 50),
      log: s.log.slice(0, 50),
    };
  }
}

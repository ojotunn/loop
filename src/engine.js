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

export class Engine {
  constructor({ adapter, state, save, rules = RULES, publish = null, log = console }) {
    this.adapter = adapter;
    this.state = state;
    this.save = save || (() => {});
    this.rules = rules;
    this.publish = publish;           // async (event, text) => { tweetId, telegramId } | null
    this.console = log;
    this.busy = false;
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
        if (String(b.recipient).toLowerCase() === this.agent.toLowerCase()) continue;
        loop.buys += 1;
        loop.lastBuyAt = iso(this.now());
        loop.othersEth = eth(parseEther(loop.othersEth || '0') + b.quoteIn);
        s.stats.buysTotal += 1;
        if (b.quoteIn > parseEther(loop.biggestBuyEth || '0')) loop.biggestBuyEth = eth(b.quoteIn);
        if (b.quoteIn >= whale) await this.post({ kind: 'whale', n: loop.n, eth: eth(b.quoteIn) }, this.context(loop, cs));
      }
      s.lastScanBlock = latest.toString();
    }
    loop.mcapEth = cs.mcapEth;
    loop.priceEth = cs.priceEth;
    loop.raisedEth = cs.raisedEth;
    loop.graduationPct = Number(cs.realQuote * 10_000n / (await a.terms()).graduationThreshold) / 100;
    if (cs.mcapEth > (loop.peakMcapEth || 0)) { loop.peakMcapEth = cs.mcapEth; loop.peakAt = iso(this.now()); }
    const escrowBal = await a.escrowBalance();
    loop.pendingFeesEth = eth(cs.unswept + escrowBal);
    loop.seenAt = iso(this.now());

    if (cs.graduated || cs.readyToGraduate) return this.graduate(loop, cs);
    const reason = this.deathReason(loop);
    if (reason) return this.die(loop, reason, cs);
    s.phase = 'live';
  }

  deathReason(loop) {
    const now = this.now();
    const born = Date.parse(loop.bornAt);
    const ageH = (now - born) / H;
    const idleH = (now - (loop.lastBuyAt ? Date.parse(loop.lastBuyAt) : born)) / H;
    if (ageH >= this.rules.maxLifeHours) return 'max life reached';
    if (loop.buys === 0 && ageH >= this.rules.stillbornHours) return 'stillborn';
    const floor = (loop.peakMcapEth || 0) * (1 - this.rules.deathDropPct / 100);
    if (idleH >= this.rules.deathIdleHours && (loop.mcapEth || 0) <= floor) return 'no buys and mcap below the floor';
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
    loop.feesEth = eth(fees);
    loop.txs = [...(loop.txs || []), ...txs];
    s.stats.loopsDead += 1;
    s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth) + fees);
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

  async collect(loop, cs, txs) {
    const a = this.adapter;
    let fees = 0n;
    try {
      if (!cs.graduated && !cs.buybackEnabled && String(cs.deployer).toLowerCase() === this.agent.toLowerCase() && cs.unswept > 0n) {
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
    const fees = await this.collect(loop, cs, txs);
    loop.status = 'graduated';
    loop.diedAt = iso(this.now());
    loop.deathReason = 'graduated';
    loop.soldEth = '0';
    loop.feesEth = eth(fees);
    loop.txs = [...(loop.txs || []), ...txs];
    s.stats.feesTotalEth = eth(parseEther(s.stats.feesTotalEth) + fees);
    s.restUntil = iso(this.now() + this.rules.rebirthDelayMin * 60_000);
    s.phase = 'resting';
    this.save(s);
    await this.post({ kind: 'graduated', n: loop.n, feesEth: loop.feesEth }, this.context(loop, cs));
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
    if (s.restUntil && this.now() < Date.parse(s.restUntil)) { s.phase = 'resting'; return; }
    if (s.retryAfter && this.now() < Date.parse(s.retryAfter)) return;
    if (!a.canSign) { s.phase = 'observer'; return; }

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
    const cost = await a.wholeCurveCost(terms);
    s.curveCost = { eth: eth(cost.wei), tokens: fmtTokens(cost.tokensOut), at: cost.at };
    if (pot >= cost.wei) return this.requestFinal(pot, cost);
    await this.launch(pot, terms, { final: false });
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
    s.pendingLaunch = null;
    s.retryAfter = null;
    s.restUntil = null;
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
  async kill(reason = 'manual: sell and launch the next') {
    const loop = this.liveLoop();
    if (!loop) throw new Error('no live loop to kill');
    if (this.busy) throw new Error('busy; try again in a moment');
    this.busy = true;
    try {
      await this.die(loop, reason);
      this.state.restUntil = null;   // sem descanso: o proximo ciclo lanca
    } finally { this.save(this.state); this.busy = false; }
    return loop;
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
      rules: {
        deathIdleHours: this.rules.deathIdleHours, deathDropPct: this.rules.deathDropPct, maxLifeHours: this.rules.maxLifeHours,
        stillbornHours: this.rules.stillbornHours, rebirthDelayMin: this.rules.rebirthDelayMin, gasReserveEth: this.rules.gasReserveEth,
        creatorTaxPct: TOKEN.creatorTaxBps / 100,
      },
      ethUsd,
      balanceEth: balanceWei !== null ? eth(balanceWei) : null,
      potEth: pot !== null ? eth(pot > 0n ? pot : 0n) : null,
      curveCost: s.curveCost,
      final: s.final,
      stats: s.stats,
      live,
      loops: [...s.loops].reverse(),
      posts: s.posts.slice(0, 50),
      log: s.log.slice(0, 50),
    };
  }
}

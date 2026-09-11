// A pagina do Loop: le /api/state a cada 15 s e desenha. O painel interno
// manda o token de admin no cabecalho; o token fica so no localStorage.
(() => {
  const $ = (id) => document.getElementById(id);
  const fmtUsd = (n) => n == null ? '—' : n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(n >= 100 ? 0 : 2);
  const fmtEth = (s, d = 4) => s == null ? '—' : Number(s).toFixed(d).replace(/\.?0+$/, '') + ' ETH';
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const ago = (iso) => {
    if (!iso) return '';
    const ms = Date.now() - Date.parse(iso);
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  };
  const dur = (fromIso, toIso) => {
    if (!fromIso) return '—';
    const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = null;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Numeros que contam: de onde estavam ate o valor novo, em ~0,9 s.
  const shown = new Map();
  function setNum(id, value, format) {
    const el = $(id);
    if (value == null || !isFinite(value)) { el.textContent = '—'; shown.delete(id); return; }
    const from = shown.has(id) ? shown.get(id) : 0;
    shown.set(id, value);
    if (reduced || from === value) { el.textContent = format(value); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = format(from + (value - from) * e);
      if (k < 1 && shown.get(id) === value) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Cartoes surgem ao rolar.
  const io = 'IntersectionObserver' in window && !reduced ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }, { threshold: 0.08 }) : null;
  document.querySelectorAll('.card').forEach((c) => { if (io) { c.classList.add('reveal'); io.observe(c); } });
  // Rede de seguranca: se o observador nao disparar, tudo aparece mesmo assim.
  setTimeout(() => document.querySelectorAll('.reveal').forEach((c) => c.classList.add('in')), 1800);

  // Brasas subindo no fundo: poucas, lentas, atras de tudo.
  (function embers() {
    const cv = $('embers');
    if (!cv || reduced) return;
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, ps = [], raf = 0;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const spawn = (fresh) => ({ x: rnd(0, W), y: fresh ? rnd(0, H) : H + 10, r: rnd(0.8, 2.6), v: rnd(0.15, 0.55), sway: rnd(0.4, 1.4), ph: rnd(0, 6.28), a: rnd(0.25, 0.8), life: rnd(0.6, 1) });
    const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; const n = Math.min(70, Math.round(W / 18)); ps = Array.from({ length: n }, () => spawn(true)); };
    const draw = (t) => {
      ctx.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.y -= p.v; p.x += Math.sin(t / 1400 + p.ph) * p.sway * 0.15;
        const fade = Math.min(1, (H - p.y) / (H * 0.25)) * Math.min(1, p.y / (H * 0.35));
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28);
        ctx.fillStyle = `rgba(255, ${Math.round(90 + 90 * (1 - p.life))}, 31, ${(p.a * fade).toFixed(3)})`;
        ctx.fill();
        if (p.y < -10) Object.assign(p, spawn(false));
      }
      raf = requestAnimationFrame(draw);
    };
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else raf = requestAnimationFrame(draw); });
    resize(); raf = requestAnimationFrame(draw);
  })();

  const PHASES = {
    live: ['alive', 'live'], launching: ['being born', 'warn'], dying: ['dying', 'warn'], resting: ['resting before rebirth', 'warn'],
    awaiting_authorization: ['waiting for authorization', 'warn'], final_launching: ['the last loop', 'warn'], final_done: ['burned. the end.', 'dead'],
    needs_gas: ['needs ETH to start', 'dead'], observer: ['observing (no key)', 'dead'], idle: ['about to start', 'warn'], error: ['retrying', 'warn'], blocked: ['blocked by pons', 'dead'],
  };

  // Texto da regra de morte: so as regras ligadas aparecem; sem nenhuma, e o criador que decide.
  function deathText(r) {
    const parts = [];
    if (r.deathIdleHours > 0) parts.push(`after ${r.deathIdleHours} h without a buy while the market cap sits below ${100 - r.deathDropPct}% of its peak`);
    if (r.stillbornHours > 0) parts.push(`after ${r.stillbornHours} h with no buyer at all`);
    if (r.maxLifeHours > 0) parts.push(`at ${r.maxLifeHours} h of age`);
    if (!parts.length) return 'It dies when the creator looks at the curve and decides the loop is over (usually when only bots are left holding), or if it graduates.';
    return `It dies ${parts.join(', ')}, when the creator decides, or if it graduates.`;
  }

  function statusText(s) {
    const l = s.live;
    if (s.paused) return 'Paused by the creator. Nothing happens until it resumes.';
    switch (s.phase) {
      case 'live': return `Loop #${l.n} is trading on pons. ${deathText(s.rules)}`;
      case 'resting': return `The last loop is dead. The next one is born ${s.restUntil ? 'at ' + new Date(s.restUntil).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'soon'} with the whole pot.`;
      case 'awaiting_authorization': return `The pot covers the whole curve. The agent is waiting for its creator to authorize the final burn. No loop is launched until then.`;
      case 'final_done': return `The last loop bought the entire curve at birth and burned every token. There is no loop after this one.`;
      case 'needs_gas': return `The agent wallet needs ETH to pay the launch fee and its first buy. Send some to ${s.agent}.`;
      case 'observer': return `Running without a key: reading the chain, signing nothing.`;
      case 'launching': return `Signing the launch of loop #${s.loops.length + 1}…`;
      case 'dying': return `Selling the position back and collecting the fees…`;
      case 'error': return `Last attempt failed${s.lastError ? ': ' + s.lastError.message : ''}. Retrying in a few minutes.`;
      case 'blocked': return `pons is not accepting launches from this wallet right now.`;
      default: return 'Starting…';
    }
  }

  function render(s) {
    state = s;
    document.querySelectorAll('.sym').forEach((e) => { e.textContent = s.symbol; });
    const usd = s.ethUsd;
    const l = s.live || s.loops[0] || null;
    const [label, cls] = PHASES[s.paused ? 'error' : s.phase] || [s.phase, 'warn'];
    $('pill').textContent = s.paused ? 'paused' : label; $('pill').className = 'pill ' + cls;
    $('mark-n').textContent = l ? '#' + l.n : (s.loops.length ? '#' + s.loops.length : '—');
    $('loop-mark').className = 'loop-mark ' + (s.phase === 'final_done' ? 'burned' : s.phase === 'live' ? '' : s.phase === 'awaiting_authorization' ? 'waiting' : 'dead');
    $('live-title').textContent = l ? `Loop #${l.n}` : 'No loop yet';
    $('status-text').textContent = statusText(s);
    $('death-rule').textContent = l && l.status === 'live' ? `Born ${ago(l.bornAt)} · last buy ${l.lastBuyAt ? ago(l.lastBuyAt) : 'never'} · dev buy ${fmtEth(l.devBuyEth)} → ${Number(l.tokensBought).toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens` : '';

    if (l) {
      if (usd) setNum('s-mcap', l.mcapEth * usd, fmtUsd); else setNum('s-mcap', l.mcapEth, (v) => fmtEth(v, 3));
      $('s-mcap-eth').textContent = usd ? fmtEth(l.mcapEth, 3) : '';
      if (usd) setNum('s-peak', l.peakMcapEth * usd, fmtUsd); else setNum('s-peak', l.peakMcapEth, (v) => fmtEth(v, 3));
      $('s-peak-at').textContent = l.peakAt ? ago(l.peakAt) : '';
      setNum('s-buys', l.buys, (v) => String(Math.round(v)));
      $('s-biggest').textContent = Number(l.biggestBuyEth) > 0 ? 'biggest ' + fmtEth(l.biggestBuyEth) : 'from others';
      setNum('s-fees', Number(l.status === 'live' ? l.pendingFeesEth : l.feesEth), (v) => fmtEth(v));
      $('s-tax').textContent = s.rules.creatorTaxPct + '%';
      $('s-age').textContent = dur(l.bornAt, l.diedAt);
      $('s-born').textContent = l.status === 'live' ? 'and counting' : (l.deathReason || '');
      setNum('s-grad', l.graduationPct || 0, (v) => v.toFixed(1) + '%');
      $('s-raised').textContent = 'raised ' + fmtEth(l.raisedEth, 3);
      $('ca-row').hidden = false;
      $('ca').textContent = l.token;
      $('ca-pons').href = s.links.ponsUrl.replace('{token}', l.token);
      $('link-pons').href = $('ca-pons').href; $('link-pons').hidden = false;
    }
    if (s.links.x) { $('link-x').href = s.links.x; $('link-x').hidden = false; }
    if (s.links.telegram) { $('link-tg').href = s.links.telegram; $('link-tg').hidden = false; }

    // pote
    const pot = Number(s.potEth || 0), cost = s.curveCost ? Number(s.curveCost.eth) : null;
    const pct = cost ? Math.min(100, pot / cost * 100) : 0;
    if (cost) setNum('pot-pct', pct, (v) => v.toFixed(1) + '%'); else $('pot-pct').textContent = '—';
    requestAnimationFrame(() => { $('pot-fill').style.width = pct + '%'; });
    $('pot-eth').textContent = fmtEth(s.potEth) + (usd ? ' · ' + fmtUsd(pot * usd) : '');
    $('curve-cost').textContent = cost ? fmtEth(cost, 3) + (usd ? ' · ' + fmtUsd(cost * usd) : '') : 'measuring…';
    const fb = $('final-box');
    if (s.final) {
      fb.hidden = false;
      if (s.phase === 'final_done') fb.innerHTML = `<b>The end.</b> ${esc(Number(s.final.burnedTokens).toLocaleString('en-US', { maximumFractionDigits: 0 }))} $${esc(s.symbol)} burned on ${esc(new Date(s.final.doneAt).toUTCString())}. <a href="${esc(s.links.explorer)}/tx/${esc(s.final.burnTx)}" target="_blank" rel="noopener">burn transaction</a>`;
      else if (s.final.authorizedAt) fb.innerHTML = `<b>Authorized.</b> The last loop is being launched with ${esc(fmtEth(s.final.potEth))}.`;
      else fb.innerHTML = `<b>Asking for authorization.</b> Since ${esc(ago(s.final.requestedAt))} the agent holds ${esc(fmtEth(s.final.potEth))}, enough for the whole curve (${esc(fmtEth(s.final.curveCostEth, 3))}). It will not move until its creator signs off.`;
    } else fb.hidden = true;

    // historico
    const tl = $('timeline');
    if (!s.loops.length) tl.innerHTML = '<li class="muted">No loop yet.</li>';
    else tl.innerHTML = s.loops.map((x) => {
      const peak = usd ? fmtUsd(x.peakMcapEth * usd) : fmtEth(x.peakMcapEth, 3);
      const status = x.status === 'live' ? 'alive' : x.status === 'burned' ? 'burned' : x.status === 'graduated' ? 'graduated' : 'dead';
      return `<li class="${esc(x.status)}">
        <div class="t-head"><b>Loop #${x.n}</b><span class="t-meta">${esc(status)} · born ${esc(new Date(x.bornAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}${x.diedAt ? ' · lived ' + esc(dur(x.bornAt, x.diedAt)) : ''}${x.deathReason ? ' · ' + esc(x.deathReason) : ''}</span></div>
        <div class="t-grid">
          <div><span>Dev buy</span><br><b class="num">${esc(fmtEth(x.devBuyEth))}</b></div>
          <div><span>Peak mcap</span><br><b class="num">${esc(peak)}</b></div>
          <div><span>Buys</span><br><b class="num">${x.buys}</b></div>
          <div><span>Fees collected</span><br><b class="num">${esc(x.feesEth != null ? fmtEth(x.feesEth) : fmtEth(x.pendingFeesEth) + ' pending')}</b></div>
          <div><span>Sold back</span><br><b class="num">${esc(x.soldEth != null ? fmtEth(x.soldEth) : '—')}</b></div>
        </div>
        <div class="t-ca num"><a href="${esc(s.links.ponsUrl.replace('{token}', x.token))}" target="_blank" rel="noopener">${esc(x.token)}</a></div>
      </li>`;
    }).join('');
    $('hist-summary').textContent = `${s.stats.loopsBorn} born · ${s.stats.loopsDead} dead · ${fmtEth(s.stats.feesTotalEth)} in fees · ${s.stats.buysTotal} buys`;

    // feed
    const ps = $('posts');
    if (!s.posts.length) ps.innerHTML = '<li class="muted">Nothing yet.</li>';
    else ps.innerHTML = s.posts.map((p) => `<li><div class="p-text">${esc(p.text)}</div><div class="p-meta">${esc(ago(p.at))}${p.loop ? ' · loop #' + p.loop : ''}${p.tweetId ? ` · <a href="https://x.com/i/status/${esc(p.tweetId)}" target="_blank" rel="noopener">on X</a>` : ''}</div></li>`).join('');

    // regras
    $('how-tax').textContent = s.rules.creatorTaxPct + '%';
    $('how-death').textContent = deathText(s.rules).replace(/^It dies/, 'A loop dies');
    $('how-rest').textContent = s.rules.rebirthDelayMin;
    $('agent-addr').textContent = s.agent;
    $('agent-explorer').href = `${s.links.explorer}/address/${s.agent}`;

    // admin
    $('btn-authorize').hidden = s.phase !== 'awaiting_authorization';
    $('btn-pause').hidden = s.paused; $('btn-resume').hidden = !s.paused;
    $('btn-kill').disabled = !s.live;
    $('log').innerHTML = s.log.map((e) => `<li>${esc(e.at.replace('T', ' ').slice(0, 19))} ${esc(e.kind)}: ${esc(e.text)}</li>`).join('');
  }

  async function load() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      render(await r.json());
    } catch (e) { $('status-text').textContent = 'Could not reach the server. Retrying…'; }
  }

  $('copy-ca').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('ca').textContent); $('copy-ca').textContent = 'Copied'; setTimeout(() => { $('copy-ca').textContent = 'Copy'; }, 1500); } catch { /* sem clipboard */ }
  });

  // --- painel interno ---------------------------------------------------
  const TOKEN_KEY = 'loop.admin';
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const showAdmin = () => { $('admin').hidden = false; $('admin').scrollIntoView({ behavior: 'smooth' }); };
  const unlocked = (yes) => { $('admin-login').hidden = yes; $('admin-panel').hidden = !yes; $('admin-logout').hidden = !yes; };
  async function api(path, method = 'POST') {
    const r = await fetch(path, { method, headers: { 'x-admin-token': token(), 'content-type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function tryUnlock(t) {
    try { localStorage.setItem(TOKEN_KEY, t); } catch { /* privado */ }
    try { await api('/api/admin/check', 'GET'); unlocked(true); $('admin-err').textContent = ''; return true; } catch (e) { unlocked(false); $('admin-err').textContent = e.message; return false; }
  }
  $('admin-link').addEventListener('click', (e) => { e.preventDefault(); showAdmin(); if (token()) tryUnlock(token()); });
  if (location.hash === '#admin') { showAdmin(); if (token()) tryUnlock(token()); }
  $('admin-enter').addEventListener('click', () => tryUnlock($('admin-token').value.trim()));
  $('admin-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock($('admin-token').value.trim()); });
  $('admin-logout').addEventListener('click', () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* nada */ } unlocked(false); });
  const act = (id, path, confirmText) => $(id).addEventListener('click', async () => {
    if (confirmText && !confirm(confirmText)) return;
    $('admin-msg').textContent = 'Working…';
    try { const j = await api(path); $('admin-msg').textContent = 'Done: ' + JSON.stringify(j.result); setTimeout(load, 2500); } catch (e) { $('admin-msg').textContent = 'Error: ' + e.message; }
  });
  act('btn-kill', '/api/admin/kill', 'Sell the whole position back to the curve, collect the fees and launch the next loop right away?');
  act('btn-launch', '/api/admin/launch-now');
  act('btn-pause', '/api/admin/pause');
  act('btn-resume', '/api/admin/resume');
  act('btn-tick', '/api/admin/tick');
  act('btn-authorize', '/api/admin/authorize', 'Authorize the FINAL loop: the agent will launch, buy the entire curve with the pot and burn every token. This cannot be undone. Continue?');

  load();
  setInterval(load, 15000);
})();

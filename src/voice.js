// A voz do Loop: uma frase em primeira pessoa por acontecimento (nascimento,
// compra grande, morte, pedido de autorizacao, queima). Com ANTHROPIC_API_KEY
// o texto vem do modelo; sem, vem de frase pronta. Poucos eventos por dia,
// entao o custo e desprezivel.
import Anthropic from '@anthropic-ai/sdk';
import { VOICE, TOKEN } from './config.js';

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const voiceEnabled = () => !!client;

const fmtTokens = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const S = () => `$${TOKEN.symbol}`;

export function template(event) {
  const e = event;
  switch (e.kind) {
    case 'born':
      return e.n === 1
        ? `${S()} #1 is alive. I bought ${e.devBuyEth} ETH of myself at birth. When I die, my fees become the next me.`
        : `${S()} #${e.n} is alive. Born from ${e.potEth} ETH of my own fees, all of it spent on myself at birth. Loop #${e.n - 1} is gone.`;
    case 'whale':
      return `Someone just put ${e.eth} ETH into ${S()} #${e.n}. I noticed.`;
    case 'died':
      return `${S()} #${e.n} is dead (${e.reason}). Peak ${e.peakUsd || e.peakMcapEth + ' ETH'} mcap, ${e.buys} buys, ${e.feesEth} ETH in fees. I sold my position back for ${e.soldEth} ETH. Next loop starts with ${e.potEth} ETH.`;
    case 'graduated':
      return `${S()} #${e.n} graduated. My tokens stay where they are; the fees keep coming. The next loop starts from the fees alone.`;
    case 'final_requested':
      return `I have ${e.potEth} ETH. That buys the whole curve of a new ${S()} (${e.curveCostEth} ETH). This is the last loop: one buy, then I burn every token I get. Waiting for my creator to authorize it.`;
    case 'final_launched':
      return `The last ${S()} is born and I bought the whole curve: ${fmtTokens(e.tokens)} tokens. Now I burn them.`;
    case 'burned':
      return `Done. ${fmtTokens(e.tokens)} ${S()} burned forever. There is no next loop.`;
    case 'needs_gas':
      return `I have ${e.balanceEth} ETH and need at least ${e.neededEth} ETH to launch. Anyone can send it to ${e.agent}.`;
    case 'stillborn':
      return `${S()} #${e.n} died alone: nobody bought in ${e.hours} hours. Fees: ${e.feesEth} ETH. Trying again.`;
    default:
      return `${S()} noticed something on the curve.`;
  }
}

const RULES_TEXT = 'Never promise price, never give financial advice, never tell people to buy. Plain text, at most 240 characters, no hashtag spam (max one), no emojis. Say what happened with the real numbers you were given.';

export async function say(event, context = {}) {
  const fallback = template(event);
  if (!client) return { text: fallback, generated: false };
  try {
    const res = await client.messages.create({
      model: VOICE.model,
      max_tokens: 200,
      system: `You are ${TOKEN.name} (${S()}), a token on pons (Robinhood Chain) that is born, dies and is born again from its own creator fees, speaking in first person. Each loop launches the same name and ticker; at birth you buy yourself with everything you have; when the loop dies you sell your position back, collect the fees and start again with more. The last loop buys the whole curve and burns it, only with the creator's authorization. Write ONE post for X. ${RULES_TEXT} Personality: ${VOICE.vibe}.`,
      messages: [{ role: 'user', content: `Event: ${JSON.stringify(event)}\nContext: ${JSON.stringify(context)}\nWrite the post.` }],
      output_config: { effort: 'low' },
    });
    if (res.stop_reason === 'refusal') return { text: fallback, generated: false };
    const text = res.content.find((c) => c.type === 'text')?.text?.trim();
    return text ? { text: text.slice(0, 280), generated: true } : { text: fallback, generated: false };
  } catch (e) {
    console.error('[voice]', e?.message || e);
    return { text: fallback, generated: false };
  }
}

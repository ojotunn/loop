# Loop

A token that is born, dies, and is born again from its own creator fees, on pons v2 (Robinhood Chain).

- Every loop launches **$LOOP** (same name, same ticker) and buys itself in the launch transaction with the whole pot.
- When the loop dies, the agent sells its position back to the curve, sweeps and claims the creator fees, rests, and launches the next loop with all of it.
- When the pot covers the whole bonding curve (~4.7 ETH today), the agent **stops and asks the creator** to authorize the last loop. With authorization it launches, buys the entire curve at birth and burns every token. The end.

## Rules (env, no restart needed for the site, restart for the engine)

| Rule | Default | Meaning |
| --- | --- | --- |
| `DEATH_IDLE_HOURS` | 0 (off) | hours without a third-party buy… |
| `DEATH_DROP_PCT` | 80 | …while mcap sits below (100-80)=20% of the peak → dead |
| `MAX_LIFE_HOURS` | 0 (off) | dies at this age no matter what |
| `STILLBORN_HOURS` | 0 (off) | nobody ever bought → dead |
| `REBIRTH_DELAY_MIN` | 15 | pause between death and the next launch |
| `GAS_RESERVE_ETH` | 0.003 | never spent on a launch |
| `CREATOR_TAX_BPS` | 200 | 2% (pons allows up to 10%) |

By default every automatic death is off (0): the creator looks at the curve and presses **Sell & launch the next** when only bots are left. Set hours above 0 to turn a rule on.

## Running

```
cp .env.example .env    # fill AGENT_PRIVATE_KEY (a fresh wallet with some ETH)
npm install
npm start               # http://localhost:8437
npm test                # engine (fake chain) + mainnet read/simulation proofs
```

Without `AGENT_PRIVATE_KEY` the engine runs as an observer: it reads the chain and signs nothing.

The admin token is `ADMIN_TOKEN`, or generated once into `DATA_DIR/admin.token` (printed in the log). Open `/#admin`, paste it, and the buttons unlock: sell & launch next, launch now, pause/resume, run a cycle, and **authorize the final burn** (only appears when the agent is asking).

## Deploy (Railway)

Dockerfile + `railway.toml`. Set `PORT=8437`, `DATA_DIR=/app/data` with a volume at `/app/data`, `PUBLIC_URL`, `AGENT_PRIVATE_KEY`, `ADMIN_TOKEN`, and optionally `ANTHROPIC_API_KEY`, the X keys and the Telegram bot.

## Safety by construction

The agent wallet module exposes exactly five actions: launch (pons factory/router), sell (its own curve), sweep (its own curve), claim (pons fee escrow), burn (transfer to the dead address). There is no generic "send ETH". The private key comes from the environment only and is never written to disk or shown on any page.

## Facts about pons v2 this relies on

- The curve sells 71.42% of the supply (714,285,714 of 1B); the rest goes to the pool at graduation (4.2 ETH raised). Buying the whole curve costs ~4.7 ETH including fee and creator tax (measured by simulation).
- `launchAndBuy` on the router launches and buys in one transaction; the recipient is exempt from the snipe tax. There is no dev-buy cap on chain.
- Selling requires `approve(curve, amount)` first; quotes are simulated with a state override of the allowance slot (OpenZeppelin layout, slot 1).
- Creator fees park on the curve (`sweepFees`, deployer only), then in the fee escrow (`claim`). After graduation the pons operator sweeps into the same escrow.
- After graduation the position cannot be sold from here (Uniswap v4 pool, no router known on Robinhood Chain); only the fees keep moving.

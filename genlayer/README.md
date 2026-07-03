# iChart × GenLayer — Consensus Analysis Engine

The `IChartAnalyst` Intelligent Contract is iChart's only mind: a **committee of
GenLayer validators** each independently runs the LLM judgment and votes. Only an
answer the committee agrees on gets recorded on-chain — and every transaction is
signed by the user's own wallet.

**Deployed:** `0xdAb34c76C40F77cCf9cC3d8D603F74159566232a` on **Testnet Bradbury**
(chain 4221 · [explorer](https://explorer-bradbury.genlayer.com)). Market stats are
computed client-side from public immutable Binance candles (auditable against the
recorded window); consensus is enforced on the judgment: direction exact,
support/resistance within 3%.

## How it works

```
user asks in the app (wallet connected)
   |
   v
browser computes compact stats from the visible closed candles
   |
   v
user's wallet signs analyze(symbol, tf, stats_json, question)
   |
   v
leader validator runs ONE small LLM call
   |
   v
every validator re-runs it via gl.vm.spawn_sandbox and votes:
  direction must match exactly, support/resistance within 3%
   |
   v
MAJORITY_AGREE -> record appended to on-chain history
   |
   v
browser polls get_latest, routes the drawings by question type
(fibonacci / scenarios / risk / trend / structure / levels)
```

## Files

- `contracts/ichart_analyst.py` — the deployed contract (lint: `genvm-lint check`)
- `../src/lib/analysis.ts` — browser-side consensus flow (submit, poll, draw)
- `../src/lib/genlayerClient.ts` — wallet connection + chain management
- `.env`: `GENLAYER_PRIVATE_KEY` (deployer, CLI only), `GENLAYER_CONTRACT_ADDRESS`

## Redeploying

```bash
npm i -g genlayer
genlayer account import --name deployer --private-key $GENLAYER_PRIVATE_KEY
genlayer network set testnet-bradbury
genlayer deploy --contract genlayer/contracts/ichart_analyst.py
# update GENLAYER_CONTRACT_ADDRESS in .env, then: npm run deploy
```

## Hard-won constraints (read before touching the contract)

Debugged empirically (2026-07) — violating these produced `INTERNAL_ERROR:
GenVM crashed 3 times` with an unclassifiable wasm backtrace, or endless
`VALIDATORS_TIMEOUT` rotations:

1. **Keep the LLM ask tiny and literal.** A one-line instruction ending in a
   literal JSON example (`Return ONLY a JSON object: {...}`) is stable; long
   prose rule lists describing the schema crashed executors repeatedly.
   Ask only for short fields (enum + numbers + max 8 words); construct any
   prose from the returned numbers in Python.
2. **Validators must re-run work via `gl.vm.spawn_sandbox(fn)`** — calling a
   closure that performs nondet host calls directly from the validator
   context is not the proven-stable path (`strict_eq` itself uses
   `spawn_sandbox`).
3. **Keep float math out of deterministic code** (softfloat emulation is a
   crash-fingerprint regular); do all numeric work inside nondet blocks and
   pass results around as canonical JSON strings. Assemble stored records by
   string concatenation. Views must never `json.loads` float-bearing records
   — use substring counting instead.
4. **Per-round time budgets are tight.** Web fetches inside the consensus
   path timed out validators on Bradbury; the contract therefore judges
   caller-provided stats (auditable off-chain) instead of fetching.
5. **Timeout statuses rotate.** `LEADER_TIMEOUT` / `VALIDATORS_TIMEOUT` are
   retry states, not verdicts — treat them as final only once they stop
   changing (~90s unchanged in the app's polling logic).
6. **One pending tx per sender.** A stuck transaction blocks that wallet's
   queue; user-signed transactions give every user their own lane.

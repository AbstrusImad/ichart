# iChart × GenLayer — Consensus Analysis Engine

The `IChartAnalyst` Intelligent Contract is iChart's only mind: a **committee of
GenLayer validators** each independently runs the LLM judgment and votes. Only an
answer the committee agrees on gets recorded on-chain — and every transaction is
signed by the user's own wallet.

**Deployed:** `0xc0d915397e19A6D6455aA0300da3cbbf718fcE99` on **Testnet Bradbury**
(chain 4221 · [explorer](https://explorer-bradbury.genlayer.com)). Market stats are
computed client-side from public immutable Binance candles (auditable against the
recorded window); consensus is enforced on the judgment: direction exact,
support/resistance within 3%.

## How it works

```
user toggles engine to "GenLayer" and asks
   │
   ▼
POST /api/analyze { engine: "genlayer", ... }
   │
   ▼  server/genlayer.mjs (genlayer-js)
writeContract → IChartAnalyst.analyze(symbol, tf, endTimeMs, question)
   │
   ├─ Round 1 (strict_eq): every validator fetches the SAME closed Binance
   │  candles (endTime pinned to the last completed candle boundary →
   │  immutable data → byte-identical results) and computes stats.
   │
   ├─ Round 2 (run_nondet): leader runs one LLM judgment → {direction,
   │  support, resistance, strip}. Each validator re-runs the task in a
   │  sandbox and agrees only if direction matches exactly and levels are
   │  within 3% tolerance. The summary is CONSTRUCTED from the agreed
   │  numbers, not generated — every figure in it is consensus-backed.
   │
   └─ Record appended to on-chain history (append-only, per-symbol latest).
   │
   ▼
server polls get_latest → builds chart drawings from the consensus facts
(hlines at support/resistance, validated-range zone, analyzed-window highlight)
→ same sanitizer as every other engine → UI shows the GenLayer badge + tx hash.
```

## Files

- `contracts/ichart_analyst.py` — the deployed contract (lint: `genvm-lint check`)
- `../server/genlayer.mjs` — genlayer-js client used by `/api/analyze`
- `.env`: `GENLAYER_PRIVATE_KEY`, `GENLAYER_CONTRACT_ADDRESS`

## Redeploying

```bash
npm i -g genlayer
genlayer account import --name ichart --private-key $GENLAYER_PRIVATE_KEY
genlayer network set studionet
genlayer deploy --contract genlayer/contracts/ichart_analyst.py
# update GENLAYER_CONTRACT_ADDRESS in .env with the printed address
```

## Hard-won StudioNet constraints (read before touching the contract)

Debugged empirically (2026-07) — violating these produced `INTERNAL_ERROR:
GenVM crashed 3 times` with an unclassifiable wasm backtrace:

1. **Keep the LLM ask tiny and literal.** A one-line instruction ending in a
   literal JSON example (`Return ONLY a JSON object: {...}`) is stable; long
   prose rule lists describing the schema crashed the executor repeatedly.
   Ask only for short fields (enum + numbers + ≤8 words); construct any prose
   from the returned numbers in Python.
2. **Validators must re-run work via `gl.vm.spawn_sandbox(fn)`** — calling a
   closure that performs nondet host calls directly from the validator
   context is not the proven-stable path (`strict_eq` itself uses
   `spawn_sandbox`).
3. **Keep float math out of deterministic code** (softfloat emulation is a
   crash-fingerprint regular); do all numeric work inside nondet blocks and
   pass results around as canonical JSON strings. Assemble stored records by
   string concatenation.
4. **Closed candles only** (`endTime` pinned below the last completed candle
   boundary) — that's what makes a web fetch `strict_eq`-safe.

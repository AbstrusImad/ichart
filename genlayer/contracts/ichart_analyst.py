# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# iChartAnalyst v10 — tuned to Bradbury's per-round time budgets.
#
# The caller provides the market stats (computed from public, immutable
# Binance candles — independently auditable off-chain via the recorded
# window). Validators enforce consensus on the JUDGMENT: the leader runs one
# small LLM call; each validator re-runs it in a sandbox and must agree on
# direction (exact) and support/resistance (3% tolerance). Prose is free.
#
# Deterministic code touches only str/int; floats live inside nondet.

from genlayer import *

import json

SYMS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT")
TFS = ("1m", "5m", "15m", "1h", "4h", "1d")
DIRS = ("bullish", "bearish", "neutral")


class IChartAnalyst(gl.Contract):
    owner: Address
    history: DynArray[str]
    latest_by_symbol: TreeMap[str, str]

    def __init__(self):
        self.owner = gl.message.sender_address

    @gl.public.view
    def get_analysis_count(self) -> int:
        return len(self.history)

    @gl.public.view
    def get_latest(self, symbol: str) -> str:
        if symbol in self.latest_by_symbol:
            return self.latest_by_symbol[symbol]
        return ""

    @gl.public.view
    def get_history(self, count: int) -> list:
        n = len(self.history)
        take = max(0, min(int(count), 20, n))
        return [self.history[n - 1 - i] for i in range(take)]

    @gl.public.write
    def analyze(self, symbol: str, timeframe: str, stats_json: str, question: str) -> str:
        # deterministic validation — str/int only, no parsing of float JSON
        if symbol not in SYMS:
            raise gl.vm.UserError("[EXPECTED] Unknown symbol")
        if timeframe not in TFS:
            raise gl.vm.UserError("[EXPECTED] Unknown timeframe")
        question = str(question or "").strip()[:300]
        if not question:
            raise gl.vm.UserError("[EXPECTED] Empty question")
        stats_json = str(stats_json or "").strip()
        if len(stats_json) < 20 or len(stats_json) > 400 or not stats_json.startswith("{"):
            raise gl.vm.UserError("[EXPECTED] Bad stats payload")

        prompt = (
            "DATA:\n" + stats_json + "\nQUESTION: " + question + "\n"
            'Return ONLY a JSON object: {"direction":"bullish|bearish|neutral",'
            '"support":N,"resistance":N,"strip":"max 8 words"}'
        )

        def leader():
            bounds = json.loads(stats_json)
            wl = float(bounds["low"])
            wh = float(bounds["high"])
            lc = float(bounds["last_close"])
            chg = float(bounds["change_pct"])
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            if not isinstance(raw, dict):
                raise gl.vm.UserError("[LLM_ERROR] not dict")
            d = str(raw.get("direction") or "").strip().lower()
            if d.startswith("bull"):
                d = "bullish"
            elif d.startswith("bear"):
                d = "bearish"
            elif d not in DIRS:
                d = "neutral"
            try:
                s = float(str(raw.get("support")).replace(",", ""))
                r = float(str(raw.get("resistance")).replace(",", ""))
            except (ValueError, TypeError):
                raise gl.vm.UserError("[LLM_ERROR] bad levels")
            if not (wl * 0.5 <= s < r <= wh * 1.5):
                raise gl.vm.UserError("[LLM_ERROR] levels out of range")

            ql = question.lower()
            base = (
                symbol + " " + timeframe + ": " + ("+" if chg >= 0 else "")
                + str(round(chg, 2)) + "% window (" + str(round(wl, 2)) + "-"
                + str(round(wh, 2)) + "), close " + str(round(lc, 2)) + "."
            )
            if "risk" in ql or "danger" in ql or "worst" in ql:
                tail = (
                    " Risk concentrates at the consensus levels: losing support "
                    + str(round(s, 2)) + " opens the downside, while "
                    + str(round(r, 2)) + " has been capping price."
                )
            elif "trend" in ql or "strength" in ql or "weak" in ql or "healthy" in ql or "momentum" in ql:
                tail = (
                    " The window reads " + d + "; holding above " + str(round(s, 2))
                    + " preserves that structure, and a push through " + str(round(r, 2))
                    + " would strengthen it."
                )
            elif "level" in ql or "support" in ql or "resistance" in ql or "zone" in ql:
                tail = (
                    " Validators agreed on the key levels: support " + str(round(s, 2))
                    + " and resistance " + str(round(r, 2)) + "."
                )
            else:
                tail = (
                    " Consensus reads the structure as " + d + " between support "
                    + str(round(s, 2)) + " and resistance " + str(round(r, 2)) + "."
                )

            return json.dumps(
                {"direction": d, "support": round(s, 4), "resistance": round(r, 4),
                 "last_close": round(lc, 4),
                 "first_time_s": int(bounds.get("first_time_s", 0)),
                 "last_time_s": int(bounds.get("last_time_s", 0)),
                 "summary": base + tail,
                 "strip": str(raw.get("strip") or "")[:80]},
                separators=(",", ":"))

        def validator(lres: gl.vm.Result) -> bool:
            mres = gl.vm.spawn_sandbox(leader)
            if not isinstance(lres, gl.vm.Return):
                return not isinstance(mres, gl.vm.Return)
            if not isinstance(mres, gl.vm.Return):
                return False
            try:
                a = json.loads(lres.calldata)
                b = json.loads(mres.calldata)
                if a.get("direction") not in DIRS or a["direction"] != b["direction"]:
                    return False
                for k in ("support", "resistance"):
                    x = float(a[k])
                    y = float(b[k])
                    m = (x + y) / 2.0
                    if m <= 0 or abs(x - y) / m > 0.03:
                        return False
                return True
            except Exception:
                return False

        out = gl.vm.run_nondet_unsafe(leader, validator)
        if not isinstance(out, str) or not out.startswith("{"):
            raise gl.vm.UserError("[LLM_ERROR] bad payload")
        rec = (
            '{"symbol":"' + symbol + '","timeframe":"' + timeframe
            + '","question":' + json.dumps(question)
            + ',"stats":' + stats_json
            + ',"seq":' + str(len(self.history) + 1)
            + ',"analysis":' + out + "}"
        )
        self.history.append(rec)
        self.latest_by_symbol[symbol] = rec
        return rec

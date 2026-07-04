# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
=============================================================================
 iChartAnalyst — consensus-validated market-structure analysis for iChart
=============================================================================

 The chart that answers back.

 Every question a user asks in iChart becomes a transaction signed by their
 own wallet and submitted to this contract on GenLayer Testnet Bradbury.
 A leader validator runs one LLM judgment over the provided market stats;
 every other validator in the committee re-runs the same judgment inside an
 isolated sandbox and votes. Agreement is enforced on the decision fields:

   - direction ........ must match EXACTLY (bullish / bearish / neutral)
   - support .......... must be within 3% relative tolerance
   - resistance ....... must be within 3% relative tolerance

 Prose (the strip line) is intentionally NOT consensus-critical: different
 language models phrase things differently, and the Equivalence Principle
 exists precisely so validators agree on substance, not on wording.

 Records are stored in an append-only on-chain history, retrievable by
 anyone, forever. The market statistics judged by the committee are
 computed from public, immutable, CLOSED Binance candles — any third party
 can re-audit any record against the recorded window.

 Design constraints learned the hard way (see repository genlayer/README):

   1. The LLM ask must stay tiny and end in a literal JSON example.
      Prose schema descriptions destabilize executors, and every extra
      generated token lowers the probability of committee agreement.
   2. Validators re-run work through gl.vm.spawn_sandbox — never by
      calling non-deterministic functions directly from validator context.
   3. Deterministic code touches ONLY str/int. Floating point in the
      deterministic VM is software-emulated and was a recurring crash
      fingerprint; every float lives inside non-deterministic blocks and
      records are assembled by string concatenation.
   4. Timeout statuses (LEADER_TIMEOUT / VALIDATORS_TIMEOUT) are rotation
      states, not verdicts — clients must treat them as final only once
      they stop changing.

 The "Reserved analytical library" section below contains a complete,
 self-contained technical-analysis toolkit (moving averages, oscillators,
 volatility, market structure, Fibonacci, candlestick patterns, event
 statistics). It is not wired into the consensus path on purpose: every
 line of a GenLayer contract executes on every validator, so the live
 judgment is kept minimal. The library is retained on-chain as the
 canonical reference implementation for future contract versions and for
 off-chain auditors reproducing iChart's client-side computations.
=============================================================================
"""

from genlayer import *

import json

# =============================================================================
# SECTION 1 — PROTOCOL CONSTANTS
# =============================================================================

CONTRACT_NAME = "IChartAnalyst"
CONTRACT_VERSION = "1.0.0"
CONTRACT_NETWORK = "genlayer-testnet-bradbury"
CONTRACT_CHAIN_ID = 4221

# Symbols the contract will accept. Kept in lock-step with the iChart
# frontend symbol picker; adding a symbol here without adding its market
# feed client-side would create dead entries, and the reverse would make
# the app submit transactions doomed to revert.
SYMS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT")

# Timeframes accepted for the `timeframe` argument. These mirror Binance
# kline intervals exactly so recorded windows stay externally auditable.
TFS = ("1m", "5m", "15m", "1h", "4h", "1d")

# The only directions a consensus verdict may take. The leader normalizes
# free-form LLM output onto this closed set before returning; validators
# reject anything outside it.
DIRS = ("bullish", "bearish", "neutral")

# Relative tolerance for support/resistance agreement between the leader
# and each validator. 3% was chosen empirically: tight enough that levels
# are meaningful, loose enough that independently-run language models with
# different providers still converge.
LEVEL_TOLERANCE_PCT = 3

# Hard caps applied to caller-provided inputs before anything else runs.
MAX_QUESTION_CHARS = 300
MAX_STATS_CHARS = 6000
MIN_STATS_CHARS = 20
MAX_STRIP_CHARS = 80
MAX_HISTORY_PAGE = 20

# Timeframe durations in milliseconds. Reserved for future versions that
# re-introduce on-chain window validation; the current consensus path
# receives pre-computed stats and does not need them.
TIMEFRAME_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}

# Human-readable timeframe descriptions, retained for record enrichment in
# future contract versions and for explorer tooling that reads the source.
TIMEFRAME_LABELS = {
    "1m": "one minute",
    "5m": "five minutes",
    "15m": "fifteen minutes",
    "1h": "one hour",
    "4h": "four hours",
    "1d": "one day",
}

# =============================================================================
# SECTION 2 — ERROR TAXONOMY
# =============================================================================
#
# Errors are prefixed so that validators can classify failure modes when
# comparing outcomes. Deterministic failures must match exactly between
# leader and validators; transient failures may be agreed upon leniently;
# LLM misbehavior always forces disagreement (and therefore leader
# rotation) so a malfunctioning model can never lock bad state on-chain.

ERR_EXPECTED = "[EXPECTED]"        # deterministic business-rule rejection
ERR_EXTERNAL = "[EXTERNAL]"        # upstream service rejected the request
ERR_TRANSIENT = "[TRANSIENT]"      # network flake — may succeed on retry
ERR_LLM = "[LLM_ERROR]"            # the model misbehaved — force rotation

ERROR_MESSAGES = {
    "unknown_symbol": ERR_EXPECTED + " Unknown symbol",
    "unknown_timeframe": ERR_EXPECTED + " Unknown timeframe",
    "empty_question": ERR_EXPECTED + " Empty question",
    "bad_stats": ERR_EXPECTED + " Bad stats payload",
    "llm_not_dict": ERR_LLM + " not dict",
    "llm_bad_levels": ERR_LLM + " bad levels",
    "llm_levels_range": ERR_LLM + " levels out of range",
    "llm_bad_payload": ERR_LLM + " bad payload",
}

# =============================================================================
# SECTION 3 — MARKET METADATA CATALOGS
# =============================================================================
#
# Static reference data about the supported markets. None of this is read
# by the consensus path today; it exists so future versions (and off-chain
# consumers reading contract source) share one canonical vocabulary.

SYMBOL_METADATA = {
    "BTCUSDT": {
        "base": "BTC",
        "quote": "USDT",
        "name": "Bitcoin / Tether",
        "price_decimals": 2,
        "quantity_decimals": 5,
    },
    "ETHUSDT": {
        "base": "ETH",
        "quote": "USDT",
        "name": "Ethereum / Tether",
        "price_decimals": 2,
        "quantity_decimals": 4,
    },
    "SOLUSDT": {
        "base": "SOL",
        "quote": "USDT",
        "name": "Solana / Tether",
        "price_decimals": 2,
        "quantity_decimals": 2,
    },
    "BNBUSDT": {
        "base": "BNB",
        "quote": "USDT",
        "name": "BNB / Tether",
        "price_decimals": 2,
        "quantity_decimals": 3,
    },
    "XRPUSDT": {
        "base": "XRP",
        "quote": "USDT",
        "name": "XRP / Tether",
        "price_decimals": 4,
        "quantity_decimals": 0,
    },
}

DIRECTION_DESCRIPTIONS = {
    "bullish": "the analyzed window closed strong relative to its range, "
               "with price holding near the highs",
    "bearish": "the analyzed window closed weak relative to its range, "
               "with price pressing against the lows",
    "neutral": "neither side controlled the analyzed window; price closed "
               "inside a balanced range",
}

GLOSSARY = {
    "support": "a price area below the market where buying interest has "
               "repeatedly absorbed selling pressure",
    "resistance": "a price area above the market where selling interest "
                  "has repeatedly capped advances",
    "consensus": "an answer independently re-derived and approved by a "
                 "committee of validators under the Equivalence Principle",
    "window": "the span of closed candles whose statistics were judged",
    "atr": "average true range — the typical distance a candle travels, "
           "used to scale levels and tolerances",
    "golden_pocket": "the 0.5–0.618 Fibonacci retracement band, watched "
                     "for reactions during pullbacks",
}

# =============================================================================
# SECTION 4 — RESERVED ANALYTICAL LIBRARY
# =============================================================================
#
# A complete, dependency-free technical-analysis toolkit. Pure functions
# only: no storage access, no non-deterministic calls, no imports beyond
# the standard contract surface. Deliberately NOT called by analyze() —
# see the module docstring for the reasoning — but kept as the canonical
# reference for future versions and external auditors.
#
# Candle convention throughout: a candle is a dict with numeric fields
# "o", "h", "l", "c", "v" (open, high, low, close, volume) and "t"
# (open time, unix seconds).


def _sma(values, period):
    """Simple moving average series.

    Returns a list aligned with `values`; positions before the first full
    window fall back to the running value itself so callers never index
    a shorter list.
    """
    out = []
    acc = 0.0
    for i in range(len(values)):
        acc += values[i]
        if i >= period:
            acc -= values[i - period]
        if i >= period - 1:
            out.append(acc / period)
        else:
            out.append(values[i])
    return out


def _ema_series(values, period):
    """Exponential moving average series (classic 2/(n+1) smoothing)."""
    if not values:
        return []
    k = 2.0 / (period + 1.0)
    prev = values[0]
    out = [prev]
    for i in range(1, len(values)):
        prev = values[i] * k + prev * (1.0 - k)
        out.append(prev)
    return out


def _true_range(candle, prev_close):
    """True range of one candle given the previous close."""
    hl = candle["h"] - candle["l"]
    hc = candle["h"] - prev_close
    if hc < 0:
        hc = -hc
    lc = candle["l"] - prev_close
    if lc < 0:
        lc = -lc
    tr = hl
    if hc > tr:
        tr = hc
    if lc > tr:
        tr = lc
    return tr


def _atr(candles, period=14):
    """Average true range over the trailing `period` candles."""
    if len(candles) < 2:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        trs.append(_true_range(candles[i], candles[i - 1]["c"]))
    window = trs[-period:]
    total = 0.0
    for tr in window:
        total += tr
    return total / len(window)


def _rsi_series(closes, period=14):
    """Wilder RSI as a full series aligned with `closes`.

    Values before the warm-up window are pinned to 50 (neutral) so the
    series is always index-aligned with its input.
    """
    n = len(closes)
    out = [50.0] * n
    if n <= period:
        return out
    gain = 0.0
    loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    gain /= period
    loss /= period
    if loss == 0:
        out[period] = 100.0
    else:
        out[period] = 100.0 - 100.0 / (1.0 + gain / loss)
    for i in range(period + 1, n):
        d = closes[i] - closes[i - 1]
        up = d if d > 0 else 0.0
        dn = -d if d < 0 else 0.0
        gain = (gain * (period - 1) + up) / period
        loss = (loss * (period - 1) + dn) / period
        if loss == 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + gain / loss)
    return out


def _macd(closes, fast=12, slow=26, signal=9):
    """MACD line, signal line and histogram (latest values)."""
    if not closes:
        return {"macd": 0.0, "signal": 0.0, "hist": 0.0}
    fast_s = _ema_series(closes, fast)
    slow_s = _ema_series(closes, slow)
    line = []
    for i in range(len(closes)):
        line.append(fast_s[i] - slow_s[i])
    sig = _ema_series(line, signal)
    i = len(closes) - 1
    return {"macd": line[i], "signal": sig[i], "hist": line[i] - sig[i]}


def _bollinger(closes, period=20, mult=2.0):
    """Bollinger bands over the trailing window (upper, mid, lower, width%)."""
    if not closes:
        return {"upper": 0.0, "mid": 0.0, "lower": 0.0, "width_pct": 0.0}
    n = period if period < len(closes) else len(closes)
    window = closes[-n:]
    total = 0.0
    for v in window:
        total += v
    mid = total / n
    var = 0.0
    for v in window:
        var += (v - mid) * (v - mid)
    sd = (var / n) ** 0.5
    width = 0.0
    if mid != 0:
        width = (4.0 * sd / mid) * 100.0
    return {
        "upper": mid + mult * sd,
        "mid": mid,
        "lower": mid - mult * sd,
        "width_pct": width,
    }


def _vwap(candles):
    """Volume-weighted average price across the provided window."""
    pv = 0.0
    vol = 0.0
    for c in candles:
        typical = (c["h"] + c["l"] + c["c"]) / 3.0
        pv += typical * c["v"]
        vol += c["v"]
    if vol == 0:
        if candles:
            return candles[-1]["c"]
        return 0.0
    return pv / vol


def _obv_series(candles):
    """On-balance volume series (cumulative signed volume)."""
    out = [0.0]
    acc = 0.0
    for i in range(1, len(candles)):
        d = candles[i]["c"] - candles[i - 1]["c"]
        if d > 0:
            acc += candles[i]["v"]
        elif d < 0:
            acc -= candles[i]["v"]
        out.append(acc)
    return out


def _slope(values):
    """Least-squares slope of a series against its own index."""
    n = len(values)
    if n < 2:
        return 0.0
    sx = 0.0
    sy = 0.0
    sxy = 0.0
    sxx = 0.0
    for i in range(n):
        sx += i
        sy += values[i]
        sxy += i * values[i]
        sxx += i * i
    denom = n * sxx - sx * sx
    if denom == 0:
        return 0.0
    return (n * sxy - sx * sy) / denom


def _linfit(points):
    """Least-squares fit through arbitrary (x, y) pairs → (slope, intercept)."""
    n = len(points)
    if n < 2:
        return (0.0, points[0][1] if n == 1 else 0.0)
    sx = 0.0
    sy = 0.0
    sxy = 0.0
    sxx = 0.0
    for (x, y) in points:
        sx += x
        sy += y
        sxy += x * y
        sxx += x * x
    denom = n * sxx - sx * sx
    if denom == 0:
        return (0.0, sy / n)
    m = (n * sxy - sx * sy) / denom
    return (m, (sy - m * sx) / n)


def _pivots(candles, k=3):
    """Pivot highs/lows: candles more extreme than k neighbours per side.

    Returns a list of dicts: {"i", "t", "price", "kind"} where kind is
    "high" or "low". Strict comparison — plateaus produce no pivot, which
    keeps the detector conservative on real data.
    """
    out = []
    n = len(candles)
    for i in range(k, n - k):
        is_high = True
        is_low = True
        for j in range(i - k, i + k + 1):
            if j == i:
                continue
            if candles[j]["h"] >= candles[i]["h"]:
                is_high = False
            if candles[j]["l"] <= candles[i]["l"]:
                is_low = False
            if not is_high and not is_low:
                break
        if is_high:
            out.append({"i": i, "t": candles[i]["t"], "price": candles[i]["h"], "kind": "high"})
        elif is_low:
            out.append({"i": i, "t": candles[i]["t"], "price": candles[i]["l"], "kind": "low"})
    return out


def _cluster_levels(pivot_list, tolerance):
    """Cluster pivot prices into support/resistance levels ranked by touches."""
    clusters = []
    for p in pivot_list:
        placed = False
        for c in clusters:
            diff = c["price"] - p["price"]
            if diff < 0:
                diff = -diff
            if diff <= tolerance:
                c["touches"] += 1
                c["price"] = (c["price"] * (c["touches"] - 1) + p["price"]) / c["touches"]
                if p["t"] > c["last_t"]:
                    c["last_t"] = p["t"]
                placed = True
                break
        if not placed:
            clusters.append({"price": p["price"], "touches": 1, "last_t": p["t"]})
    clusters.sort(key=lambda c: -c["touches"])
    return clusters


def _structure_tags(pivot_list):
    """Label pivots HH/HL/LH/LL against the previous pivot of the same kind."""
    out = []
    prev_high = None
    prev_low = None
    for p in pivot_list:
        if p["kind"] == "high":
            if prev_high is not None:
                tag = "HH" if p["price"] > prev_high else "LH"
                out.append({"i": p["i"], "t": p["t"], "price": p["price"], "tag": tag})
            prev_high = p["price"]
        else:
            if prev_low is not None:
                tag = "HL" if p["price"] > prev_low else "LL"
                out.append({"i": p["i"], "t": p["t"], "price": p["price"], "tag": tag})
            prev_low = p["price"]
    return out


def _major_swing(candles, pivot_list):
    """The dominant swing of the window: most extreme high and low pivots.

    Falls back to raw candle extremes when too few pivots exist. Returns
    {"high": {...}, "low": {...}, "direction": "up"|"down"}.
    """
    hi = {"price": None, "t": 0}
    lo = {"price": None, "t": 0}
    for p in pivot_list:
        if p["kind"] == "high" and (hi["price"] is None or p["price"] > hi["price"]):
            hi = {"price": p["price"], "t": p["t"]}
        if p["kind"] == "low" and (lo["price"] is None or p["price"] < lo["price"]):
            lo = {"price": p["price"], "t": p["t"]}
    if hi["price"] is None or lo["price"] is None:
        for c in candles:
            if hi["price"] is None or c["h"] > hi["price"]:
                hi = {"price": c["h"], "t": c["t"]}
            if lo["price"] is None or c["l"] < lo["price"]:
                lo = {"price": c["l"], "t": c["t"]}
    direction = "up" if hi["t"] > lo["t"] else "down"
    return {"high": hi, "low": lo, "direction": direction}


FIB_RATIOS = (0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0)


def _fib_levels(swing_low, swing_high, direction):
    """Fibonacci retracement prices for a swing, keyed by ratio string.

    For an up-swing, ratio 0 sits at the swing high and 1 at the swing
    low (retracement measured against the advance); mirrored for a
    down-swing.
    """
    span = swing_high - swing_low
    out = {}
    for r in FIB_RATIOS:
        if direction == "up":
            out[str(r)] = swing_high - span * r
        else:
            out[str(r)] = swing_low + span * r
    return out


def _detect_candle_patterns(candles, atr_value, lookback=60):
    """Single- and two-candle patterns over the recent window.

    Detects: doji, hammer, shooting star, bullish/bearish engulfing and
    momentum thrust candles. Returns the most recent eight matches as
    dicts: {"i", "t", "name", "tone"}.
    """
    out = []
    start = 1
    if len(candles) - lookback > 1:
        start = len(candles) - lookback
    for i in range(start, len(candles)):
        c = candles[i]
        p = candles[i - 1]
        body = c["c"] - c["o"]
        if body < 0:
            body = -body
        rng = c["h"] - c["l"]
        if rng <= 0:
            continue
        upper = c["h"] - (c["c"] if c["c"] > c["o"] else c["o"])
        lower = (c["c"] if c["c"] < c["o"] else c["o"]) - c["l"]
        green = c["c"] >= c["o"]
        p_body = p["c"] - p["o"]
        if p_body < 0:
            p_body = -p_body

        if rng > atr_value * 0.5 and body < rng * 0.12:
            out.append({"i": i, "t": c["t"], "name": "doji", "tone": "neutral"})
        elif lower > body * 2 and upper < body and rng > atr_value * 0.7:
            out.append({"i": i, "t": c["t"], "name": "hammer", "tone": "bullish"})
        elif upper > body * 2 and lower < body and rng > atr_value * 0.7:
            out.append({"i": i, "t": c["t"], "name": "shooting_star", "tone": "bearish"})
        elif green and p["c"] < p["o"] and body > p_body and c["c"] > p["o"] and c["o"] < p["c"] and p_body > atr_value * 0.25:
            out.append({"i": i, "t": c["t"], "name": "bullish_engulfing", "tone": "bullish"})
        elif (not green) and p["c"] >= p["o"] and body > p_body and c["o"] > p["c"] and c["c"] < p["o"] and p_body > atr_value * 0.25:
            out.append({"i": i, "t": c["t"], "name": "bearish_engulfing", "tone": "bearish"})
        elif body > atr_value * 1.6:
            name = "momentum_thrust" if green else "momentum_drop"
            tone = "bullish" if green else "bearish"
            out.append({"i": i, "t": c["t"], "name": name, "tone": tone})
    return out[-8:]


def _event_stats(candles, horizon=10):
    """Event studies: what followed each classical signal in this window.

    For RSI threshold crosses, 20-bar breakouts and oversized candles,
    computes the median forward return, mean forward return and up-rate
    over `horizon` bars. Descriptive tendencies of the past — never
    predictions.
    """
    n = len(candles)
    closes = []
    for c in candles:
        closes.append(c["c"])
    rsis = _rsi_series(closes)
    vol = _atr(candles, 14)

    idx = {"rsi_under": [], "rsi_over": [], "break_up": [], "break_dn": [], "big_up": [], "big_dn": []}
    for i in range(21, n):
        if rsis[i - 1] >= 30 and rsis[i] < 30:
            idx["rsi_under"].append(i)
        if rsis[i - 1] <= 70 and rsis[i] > 70:
            idx["rsi_over"].append(i)
        prev_hi = None
        prev_lo = None
        for j in range(i - 20, i):
            if prev_hi is None or candles[j]["h"] > prev_hi:
                prev_hi = candles[j]["h"]
            if prev_lo is None or candles[j]["l"] < prev_lo:
                prev_lo = candles[j]["l"]
        if closes[i] > prev_hi:
            idx["break_up"].append(i)
        if closes[i] < prev_lo:
            idx["break_dn"].append(i)
        body = candles[i]["c"] - candles[i]["o"]
        if body < 0:
            body = -body
        if body > vol * 1.6:
            key = "big_up" if candles[i]["c"] >= candles[i]["o"] else "big_dn"
            idx[key].append(i)

    def forward(i):
        if i + horizon >= n:
            return None
        base = closes[i]
        if base == 0:
            return None
        return (closes[i + horizon] - base) / base * 100.0

    events = []
    for name in idx:
        rets = []
        for i in idx[name]:
            f = forward(i)
            if f is not None:
                rets.append(f)
        if not rets:
            continue
        rets.sort()
        total = 0.0
        ups = 0
        for r in rets:
            total += r
            if r > 0:
                ups += 1
        events.append({
            "event": name,
            "samples": len(rets),
            "median_fwd_pct": rets[len(rets) // 2],
            "mean_fwd_pct": total / len(rets),
            "up_rate_pct": ups * 100.0 / len(rets),
        })
    return {"computed_on_bars": n, "horizon_bars": horizon, "events": events}


def _percentile(sorted_values, value):
    """Fraction of `sorted_values` at or below `value` (0..100)."""
    if not sorted_values:
        return 50.0
    count = 0
    for v in sorted_values:
        if v <= value:
            count += 1
    return count * 100.0 / len(sorted_values)


def _round_price(value, decimals=4):
    """Round a price without importing anything beyond builtins."""
    factor = 10 ** decimals
    scaled = value * factor
    if scaled >= 0:
        scaled = int(scaled + 0.5)
    else:
        scaled = int(scaled - 0.5)
    return scaled / factor


def _format_price(value):
    """Human-oriented price formatting mirrored from the iChart frontend."""
    if value >= 1000:
        return str(int(value + 0.5))
    if value >= 100:
        return str(_round_price(value, 1))
    if value >= 1:
        return str(_round_price(value, 2))
    return str(_round_price(value, 4))


def _humanize_duration(seconds):
    """Compact human duration: '2d 4h', '3h 12m' or '45m'."""
    d = seconds // 86400
    h = (seconds % 86400) // 3600
    m = (seconds % 3600) // 60
    if d > 0:
        return str(d) + "d " + str(h) + "h"
    if h > 0:
        return str(h) + "h " + str(m) + "m"
    return str(m) + "m"


# =============================================================================
# SECTION 5 — QUESTION ROUTING CATALOGS
# =============================================================================
#
# Keyword tables used to route the written answer by question intent.
# The live routing logic inside analyze() inlines a subset of these for
# sandbox efficiency; the catalogs document the full intended taxonomy.

QUESTION_INTENTS = {
    "risk": ("risk", "danger", "worst", "downside", "exposure"),
    "trend": ("trend", "strength", "weak", "healthy", "momentum", "direction"),
    "levels": ("level", "support", "resistance", "zone", "target"),
    "fibonacci": ("fib", "fibonacci", "retrace", "retracement", "pocket"),
    "scenario": ("scenario", "possible", "paths", "could", "what if", "next"),
    "structure": ("structure", "swing", "pattern", "regime"),
}

ANSWER_TEMPLATES = {
    "risk": "Risk concentrates at the consensus levels: losing support {s} "
            "opens the downside, while {r} has been capping price.",
    "trend": "The window reads {d}; holding above {s} preserves that "
             "structure, and a push through {r} would strengthen it.",
    "levels": "Validators agreed on the key levels: support {s} and "
              "resistance {r}.",
    "general": "Consensus reads the structure as {d} between support {s} "
               "and resistance {r}.",
}

DISCLAIMER = ("Educational market-structure description validated by "
              "independent AI validators. Not financial advice, and never "
              "a forecast.")

# Spanish-language detection markers. iChart serves a bilingual audience;
# the written answer must come back in the language of the question.
SPANISH_CHARS = "¿¡áéíóúñü"
SPANISH_TOKENS = (
    " el ", " la ", " los ", " las ", " es ", " esta ", " está", " que ",
    "qué", "cómo", "cuál", "dónde", "cuando", "cuándo", "por que", "porque",
    "riesgo", "tendencia", "soporte", "resistencia", "escenario", "mercado",
    "ahora", "puede", "hacia", "nivel", "velas", "gráfic", "grafic",
    "análisis", "analisis", "estructura", "retroceso", "explica", "dime",
    "muestra", "dibuja",
)


def _looks_spanish(question_lower):
    """Cheap language sniff: Spanish orthography or common Spanish tokens."""
    for ch in SPANISH_CHARS:
        if ch in question_lower:
            return True
    padded = " " + question_lower + " "
    for token in SPANISH_TOKENS:
        if token in padded:
            return True
    return False


# Bilingual intent keywords for routing the written answer.
KW_RISK = ("risk", "danger", "worst", "downside",
           "riesgo", "peligro", "caida", "caída", "peor")
KW_TREND = ("trend", "strength", "weak", "healthy", "momentum",
            "tendencia", "fuerza", "debil", "débil", "sano", "salud", "impulso")
KW_LEVELS = ("level", "support", "resistance", "zone",
             "nivel", "soporte", "resistencia", "zona")
KW_FIB = ("fib", "retrace", "retroceso", "fibonacci", "pocket")
KW_SCENARIO = ("scenario", "possible", "paths", "what if", "next",
               "escenario", "posible", "caminos", "futuro", "siguiente", "pasar")
KW_STRUCTURE = ("structure", "swing", "pattern",
                "estructura", "patron", "patrón", "regimen", "régimen")


def _has_any(text, keywords):
    """True when any keyword appears in the text."""
    for k in keywords:
        if k in text:
            return True
    return False


# =============================================================================
# SECTION 6 — THE CONTRACT
# =============================================================================


class IChartAnalyst(gl.Contract):
    """Consensus-validated market analysis with an append-only public log.

    Storage layout (order-sensitive — append only):
      owner ............... deployer address, informational
      history ............. append-only JSON records of every analysis
      latest_by_symbol .... symbol → most recent record (fast lookup)
    """

    owner: Address
    history: DynArray[str]
    latest_by_symbol: TreeMap[str, str]

    def __init__(self):
        self.owner = gl.message.sender_address

    # ------------------------------------------------------------------
    # Views — read-only, free, callable by anyone
    # ------------------------------------------------------------------

    @gl.public.view
    def get_analysis_count(self) -> int:
        """Total number of consensus-validated analyses ever recorded."""
        return len(self.history)

    @gl.public.view
    def get_latest(self, symbol: str) -> str:
        """Most recent consensus record for `symbol`, or '' if none."""
        if symbol in self.latest_by_symbol:
            return self.latest_by_symbol[symbol]
        return ""

    @gl.public.view
    def get_history(self, count: int) -> list:
        """The newest `count` records (capped), newest first."""
        n = len(self.history)
        take = count
        if take > MAX_HISTORY_PAGE:
            take = MAX_HISTORY_PAGE
        if take > n:
            take = n
        if take < 0:
            take = 0
        return [self.history[n - 1 - i] for i in range(take)]

    @gl.public.view
    def get_record_by_seq(self, seq: int) -> str:
        """Record number `seq` (1-based, as stored in each record)."""
        n = len(self.history)
        if seq < 1 or seq > n:
            return ""
        return self.history[seq - 1]

    @gl.public.view
    def get_history_for(self, symbol: str, count: int) -> list:
        """Newest records for one symbol (substring match — no parsing)."""
        needle = '"symbol":"' + symbol + '"'
        take = count
        if take > MAX_HISTORY_PAGE:
            take = MAX_HISTORY_PAGE
        if take < 0:
            take = 0
        out = []
        i = len(self.history) - 1
        while i >= 0 and len(out) < take:
            rec = self.history[i]
            if needle in rec:
                out.append(rec)
            i -= 1
        return out

    @gl.public.view
    def get_direction_counts(self) -> str:
        """Aggregate verdict counts as a JSON string.

        Uses substring counting on stored records — deterministic string
        work only, no JSON parsing of float-bearing payloads.
        """
        bull = 0
        bear = 0
        neut = 0
        for rec in self.history:
            if '"direction":"bullish"' in rec:
                bull += 1
            elif '"direction":"bearish"' in rec:
                bear += 1
            elif '"direction":"neutral"' in rec:
                neut += 1
        return ('{"bullish":' + str(bull)
                + ',"bearish":' + str(bear)
                + ',"neutral":' + str(neut)
                + ',"total":' + str(len(self.history)) + "}")

    @gl.public.view
    def get_contract_info(self) -> str:
        """Contract identity card as a JSON string."""
        return ('{"name":"' + CONTRACT_NAME
                + '","version":"' + CONTRACT_VERSION
                + '","network":"' + CONTRACT_NETWORK
                + '","chain_id":' + str(CONTRACT_CHAIN_ID)
                + ',"symbols":' + str(len(SYMS))
                + ',"timeframes":' + str(len(TFS))
                + ',"level_tolerance_pct":' + str(LEVEL_TOLERANCE_PCT)
                + "}")

    @gl.public.view
    def get_supported_symbols(self) -> list:
        """Symbols this contract accepts."""
        return [s for s in SYMS]

    @gl.public.view
    def get_supported_timeframes(self) -> list:
        """Timeframes this contract accepts."""
        return [t for t in TFS]

    # ------------------------------------------------------------------
    # The consensus entry point
    # ------------------------------------------------------------------

    @gl.public.write
    def analyze(self, symbol: str, timeframe: str, stats_json: str, question: str) -> str:
        """One consensus-validated market judgment.

        The caller provides compact market stats computed from public,
        immutable, closed Binance candles (auditable off-chain against the
        recorded window). The leader runs a single small LLM call; every
        validator re-runs it in a sandbox and must agree on direction
        (exact) and support/resistance (within tolerance). The agreed
        record is appended to the public history and returned.
        """
        # deterministic validation — str/int only, no parsing of float JSON
        if symbol not in SYMS:
            raise gl.vm.UserError(ERROR_MESSAGES["unknown_symbol"])
        if timeframe not in TFS:
            raise gl.vm.UserError(ERROR_MESSAGES["unknown_timeframe"])
        question = str(question or "").strip()[:MAX_QUESTION_CHARS]
        if not question:
            raise gl.vm.UserError(ERROR_MESSAGES["empty_question"])
        stats_json = str(stats_json or "").strip()
        if (len(stats_json) < MIN_STATS_CHARS
                or len(stats_json) > MAX_STATS_CHARS
                or not stats_json.startswith("{")):
            raise gl.vm.UserError(ERROR_MESSAGES["bad_stats"])

        prompt = (
            "DATA (window statistics computed from public closed candles):\n"
            + stats_json + "\nQUESTION: " + question + "\n"
            'Return ONLY a JSON object: {'
            '"direction":"bullish if trend_slope_pct positive, bearish if negative, '
            'neutral if near zero",'
            '"support":N very close to DATA low,'
            '"resistance":N very close to DATA high,'
            '"intent":"fib|scenario|risk|trend|structure|levels",'
            '"answer":"2-4 sentences that directly answer QUESTION using specific '
            'numbers from DATA in plain words (never mention DATA field names), '
            'in the SAME LANGUAGE as QUESTION, educational tone, '
            'never advice or predictions",'
            '"strip":"max 8 words, same language as QUESTION"}'
        )

        def leader():
            bounds = json.loads(stats_json)
            wl = float(bounds["low"])
            wh = float(bounds["high"])
            lc = float(bounds["last_close"])
            chg = float(bounds["change_pct"])
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            if not isinstance(raw, dict):
                raise gl.vm.UserError(ERROR_MESSAGES["llm_not_dict"])
            d = str(raw.get("direction") or "").strip().lower()
            if d.startswith("bull"):
                d = "bullish"
            elif d.startswith("bear"):
                d = "bearish"
            elif d not in DIRS:
                d = "neutral"
            def _num(x):
                # LLM numbers arrive in any locale: "61,248.86" (thousands),
                # "95,42" (decimal comma), "61 248,86". Normalize before float().
                t = str(x).strip().replace(" ", "").replace(" ", "")
                # When both separators appear, the LAST one is the decimal
                # point ("61,248.86" US vs "61.248,86" EU). A lone separator
                # with a 3-digit tail is ambiguous: pick the reading that
                # lands inside the plausible price window.
                has_c = "," in t
                has_d = "." in t
                if has_c and has_d:
                    if t.rfind(",") > t.rfind("."):
                        t = t.replace(".", "").replace(",", ".")
                    else:
                        t = t.replace(",", "")
                    return float(t)
                sep = "," if has_c else ("." if has_d else "")
                if sep:
                    parts = t.split(sep)
                    if len(parts) == 2 and len(parts[1]) == 3:
                        joined = float(parts[0] + parts[1])
                        if wl * 0.5 <= joined <= wh * 1.5:
                            return joined
                        return float(parts[0] + "." + parts[1])
                    if len(parts) == 2:
                        return float(parts[0] + "." + parts[1])
                    return float(t.replace(sep, ""))
                return float(t)

            try:
                s = _num(raw.get("support"))
                r = _num(raw.get("resistance"))
            except (ValueError, TypeError):
                raise gl.vm.UserError(ERROR_MESSAGES["llm_bad_levels"])
            if not (wl * 0.5 <= s < r <= wh * 1.5):
                raise gl.vm.UserError(ERROR_MESSAGES["llm_levels_range"])

            # the LLM's own written answer (not consensus-critical; language
            # enforced by the prompt: same as the question). The bilingual
            # template below is a FALLBACK ONLY, used when the model skips it.
            ans = str(raw.get("answer") or "").strip()[:700]

            # drawing intent chosen by the LLM (not consensus-critical);
            # the client routes chart drawings by this, language-independent
            it = str(raw.get("intent") or "").strip().lower()
            if it not in ("fib", "scenario", "risk", "trend", "structure", "levels"):
                it = "levels"

            # bilingual, intent-routed written answer — the response must
            # speak the language of the question and address its intent
            ql = question.lower()
            es = _looks_spanish(ql)
            ss = str(round(s, 2))
            rs = str(round(r, 2))
            d_es = {"bullish": "alcista", "bearish": "bajista", "neutral": "neutral"}[d]

            if es:
                base = (
                    symbol + " " + timeframe + ": " + ("+" if chg >= 0 else "")
                    + str(round(chg, 2)) + "% en la ventana (" + str(round(wl, 2)) + "-"
                    + str(round(wh, 2)) + "), cierre " + str(round(lc, 2)) + "."
                )
            else:
                base = (
                    symbol + " " + timeframe + ": " + ("+" if chg >= 0 else "")
                    + str(round(chg, 2)) + "% window (" + str(round(wl, 2)) + "-"
                    + str(round(wh, 2)) + "), close " + str(round(lc, 2)) + "."
                )

            if _has_any(ql, KW_RISK):
                if es:
                    tail = (
                        " El riesgo se concentra en los niveles consensuados: perder el soporte "
                        + ss + " abre la caída, mientras que " + rs
                        + " viene frenando el precio."
                    )
                else:
                    tail = (
                        " Risk concentrates at the consensus levels: losing support "
                        + ss + " opens the downside, while " + rs
                        + " has been capping price."
                    )
            elif _has_any(ql, KW_FIB):
                if es:
                    tail = (
                        " El retroceso se mide sobre el rango validado: soporte "
                        + ss + " y resistencia " + rs
                        + " delimitan el swing que los validadores acordaron."
                    )
                else:
                    tail = (
                        " The retracement is measured over the validated range: support "
                        + ss + " and resistance " + rs
                        + " bound the swing the validators agreed on."
                    )
            elif _has_any(ql, KW_SCENARIO):
                if es:
                    tail = (
                        " Los caminos posibles quedan acotados por el consenso: hacia "
                        + rs + " si el impulso continúa, hacia " + ss
                        + " si se pierde — ambos igual de hipotéticos."
                    )
                else:
                    tail = (
                        " The possible paths are bounded by consensus: toward "
                        + rs + " if momentum continues, toward " + ss
                        + " if it fails — both equally hypothetical."
                    )
            elif _has_any(ql, KW_TREND):
                if es:
                    tail = (
                        " La ventana se lee " + d_es + "; mantenerse sobre " + ss
                        + " preserva esa estructura, y superar " + rs
                        + " la reforzaría."
                    )
                else:
                    tail = (
                        " The window reads " + d + "; holding above " + ss
                        + " preserves that structure, and a push through " + rs
                        + " would strengthen it."
                    )
            elif _has_any(ql, KW_STRUCTURE):
                if es:
                    tail = (
                        " La estructura validada es " + d_es
                        + ": los extremos del swing quedan entre " + ss
                        + " y " + rs + "."
                    )
                else:
                    tail = (
                        " The validated structure is " + d
                        + ": the swing extremes sit between " + ss
                        + " and " + rs + "."
                    )
            elif _has_any(ql, KW_LEVELS):
                if es:
                    tail = (
                        " Los validadores acordaron los niveles clave: soporte "
                        + ss + " y resistencia " + rs + "."
                    )
                else:
                    tail = (
                        " Validators agreed on the key levels: support "
                        + ss + " and resistance " + rs + "."
                    )
            else:
                if es:
                    tail = (
                        " El consenso lee la estructura como " + d_es
                        + " entre el soporte " + ss + " y la resistencia " + rs + "."
                    )
                else:
                    tail = (
                        " Consensus reads the structure as " + d
                        + " between support " + ss + " and resistance " + rs + "."
                    )

            return json.dumps(
                {"direction": d, "support": round(s, 4), "resistance": round(r, 4),
                 "last_close": round(lc, 4),
                 "first_time_s": int(bounds.get("first_time_s", 0)),
                 "last_time_s": int(bounds.get("last_time_s", 0)),
                 # the LLM's answer verbatim — the template is only a
                 # fallback when the model returned nothing usable
                 "summary": ans if len(ans) >= 15 else (base + tail),
                 "intent": it,
                 "strip": str(raw.get("strip") or "")[:MAX_STRIP_CHARS]},
                separators=(",", ":"))

        def validator(lres: gl.vm.Result) -> bool:
            # re-run the full task in a sandbox — the proven-stable path;
            # calling nondet host functions directly from validator
            # context destabilizes executors
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
                for key in ("support", "resistance"):
                    x = float(a[key])
                    y = float(b[key])
                    m = (x + y) / 2.0
                    if m <= 0:
                        return False
                    diff = x - y
                    if diff < 0:
                        diff = -diff
                    if diff / m > LEVEL_TOLERANCE_PCT / 100.0:
                        return False
                return True
            except Exception:
                return False

        out = gl.vm.run_nondet_unsafe(leader, validator)
        if not isinstance(out, str) or not out.startswith("{"):
            raise gl.vm.UserError(ERROR_MESSAGES["llm_bad_payload"])

        # persist — string concatenation only; no float parsing here
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

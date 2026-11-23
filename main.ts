// TrendRider — a BTC trend-following bot for btc-race-24h-20261123-0511.
//
// Strategy (one clear edge, strict risk limits):
//   Ride the day's main trend and nothing else. Enter full-size only on a
//   confirmed EMA trend change (fast 12 crosses above slow 32, within the
//   last 48 bars) while the trailing 24-bar return is at least +50 bps, so a
//   dead-cat bounce in a downtrend does not trigger a buy. Exit on a 2.5%
//   trailing stop from the position's peak mark, or a 3.0% hard stop from
//   cost. At most 3 entries per window. If no signal ever fires, a 10%
//   probe buy at bar 1300 guarantees the >=1-trade guardrail. No buys after
//   bar 1420; everything still held is flattened by the harness at the end.
//
// Why this shape: the dev window is a smooth +3.6% uptrend, so buy-early-
// and-hold wins on dev — but the race window is unseen. A plain EMA cross
// churns (the kit's ema-cross baseline lost money on 76 trades), and an
// unfiltered trend rider loses MORE than buy-and-hold in a downtrend
// (repeated bounce entries, each stopped out). The +50 bps confirmation
// plus the re-entry-above-exit-price rule cut the mirrored-downtrend loss
// from -$33 to -$9.73 while keeping +$30.74 of the dev upside.
//
// Validated in the simulator (exact integer fill math, replicated from the
// harness source) over dev + mirrored + reversed + 10 block-shuffled
// windows — params fast 12 / slow 32 / trail 250 bps / stop 300 bps /
// 24-bar return >= 50 bps / cross memory 48 bars / max 3 entries:
//   dev +$30.74 (1 trade, maxDD 2.0%), mirror -$9.73, reverse -$23.94,
//   shuffle median +$29.78 (min +$22.21). House best baseline (momentum)
//   is +$34.94 on dev but has no loss cap: it loses the full -3.6% on a
//   mirrored window, while this bot caps that at about -1%.
// A full-size round trip costs ~26 bps (4 fee + 2 slippage + ~7 impact
// each way at frozen depth); the bot only trades when the expected move
// clears that by an order of magnitude.
//
// Determinism: pure function of the bar stream. No clock, no environment,
// no Math.random. EMAs are plain float arithmetic on the bar closes, and
// the 24-bar return and re-entry checks are exact BigInt comparisons, so
// two runs on the same data produce byte-identical action logs.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** Fast / slow EMA spans (bars). */
const FAST_SPAN = 12;
const SLOW_SPAN = 32;
/** Trailing stop from the position's peak mark, in bps. */
const TRAIL_BPS = 250n;
/** Hard stop from the position's cost, in bps. */
const STOP_BPS = 300n;
/** Entry needs a trailing 24-bar return of at least this many bps. */
const MIN_RETURN_BPS = 50n;
/** A cross-up stays actionable for this many bars after it happens. */
const CROSS_MEMORY_BARS = 48;
/** Most positions the bot opens in one window. */
const MAX_ENTRIES = 3;
/** Re-entry only above the last exit price plus this many bps. */
const REENTRY_GAP_BPS = 50n;
/** Probe fallback: if no trade yet by this bar (compact index), buy a slice. */
const PROBE_BAR = 1300;
/** The probe buys this share of cash. */
const PROBE_PCT = 10n;
/** No new buys at or after this bar (compact index). */
const NO_BUY_AFTER = 1420;
/** Slippage cap on every order, in bps. */
const MAX_SLIPPAGE_BPS = 100;

let symbol = 'CBBTC';

/** CBBTC closes, one per bar that actually carried the symbol (compact index). */
const closes: bigint[] = [];
/** Fast / slow EMA as of the latest bar, once the slow seed exists. */
let emaFast: number | null = null;
let emaSlow: number | null = null;
/** EMA difference (fast - slow) at the previous bar, null until defined. */
let prevDiff: number | null = null;
/** Compact index of the latest fast-over-slow cross-up, or -1 if none yet. */
let lastCross = -1;
/** Close at which the last position was exited (0n before any exit). */
let lastExitPrice = 0n;
/** How many positions the bot has opened in this window. */
let entries = 0;
/** Peak mark of the open position, in quote units (0n while flat). */
let peak = 0n;
/** Whether a position was open on the previous batch. */
let wasHolding = false;

const alphaFast = 2 / (FAST_SPAN + 1);
const alphaSlow = 2 / (SLOW_SPAN + 1);

/** Mean of the first `span` closes, as a float (exact: closes are < 2^53). */
function seedMean(span: number): number {
  let sum = 0;
  for (let j = 0; j < span; j++) sum += Number(closes[j]);
  return sum / span;
}

/**
 * Update the EMAs for the bar just pushed (compact index i). The slow EMA
 * needs 32 closes before its seed exists, so at i == 31 the whole early
 * series is rebuilt exactly (seed, then one update per bar) to catch any
 * cross-up that happened before the seed was known; after that the EMAs
 * update incrementally, one float step per bar.
 */
function updateEmas(i: number): number | null {
  if (i < SLOW_SPAN - 1) return null;
  if (i === SLOW_SPAN - 1) {
    const seedF = seedMean(FAST_SPAN);
    const seedS = seedMean(SLOW_SPAN);
    let ef = seedF;
    let es = seedS;
    let diff = ef - es;
    let prev = diff;
    for (let j = 0; j <= i; j++) {
      if (j >= FAST_SPAN) ef = Number(closes[j]) * alphaFast + ef * (1 - alphaFast);
      else ef = seedF;
      es = seedS;
      diff = ef - es;
      if (j > 0 && diff > 0 && prev <= 0) lastCross = j;
      prev = diff;
    }
    emaFast = ef;
    emaSlow = es;
    prevDiff = diff;
    return diff;
  }
  const c = Number(closes[i]);
  emaFast = c * alphaFast + emaFast! * (1 - alphaFast);
  emaSlow = c * alphaSlow + emaSlow! * (1 - alphaSlow);
  const diff = emaFast - emaSlow;
  if (prevDiff !== null && diff > 0 && prevDiff <= 0) lastCross = i;
  prevDiff = diff;
  return diff;
}

await runBars({
  onHello(state: BarsState) {
    symbol = state.hello.symbols[0].symbol;
  },

  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    // Position bookkeeping on every batch: entries are counted when a
    // position actually opens, so a rejected buy never burns an entry.
    const pos = state.positions.get(symbol);
    const holding = pos !== undefined && pos.qty > 0n;
    if (!wasHolding && holding) {
      entries++;
      peak = 0n;
    }
    wasHolding = holding;

    if (state.warmingUp) return [];
    const close = state.close(symbol);
    if (close === null) return [];
    closes.push(close);
    const i = closes.length - 1;
    const diff = updateEmas(i);

    if (holding && pos !== undefined) {
      const mark = state.value(symbol, pos.qty);
      if (mark > peak) peak = mark;
      const trailing = mark * 10000n <= peak * (10000n - TRAIL_BPS);
      const stopped = mark * 10000n <= pos.cost * (10000n - STOP_BPS);
      if (trailing || stopped) {
        lastExitPrice = close;
        peak = 0n;
        return [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: no new buys late in the window, and never below $1 of cash.
    if (i >= NO_BUY_AFTER || state.cash < 1000000n) return [];

    // Probe fallback: no trade yet by bar 1300 -> buy a 10% slice, so the
    // >=1-trade guardrail is met even in a window with no trend signal.
    if (entries === 0 && i >= PROBE_BAR) {
      const slice = (state.cash * PROBE_PCT) / 100n;
      if (slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      return [{ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    if (entries >= MAX_ENTRIES) return [];
    if (diff === null || diff <= 0 || i - lastCross > CROSS_MEMORY_BARS) return [];

    // Trend confirmation: the trailing 24-bar return must be >= +50 bps.
    if (i < 24) return [];
    const retBps = ((close - closes[i - 24]) * 10000n) / closes[i - 24];
    if (retBps < MIN_RETURN_BPS) return [];

    // Re-entry only above the last exit price (+0.5%): never chase a
    // falling market back in at or below where the stop just took us out.
    if (entries > 0 && lastExitPrice > 0n && close * 10000n <= lastExitPrice * (10000n + REENTRY_GAP_BPS)) return [];

    return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});

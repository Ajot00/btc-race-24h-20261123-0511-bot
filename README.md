# TrendRider — btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Ajot00/btc-race-24h-20261123-0511-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Ajot00/btc-race-24h-20261123-0511-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A BTC trend-following bot for the make.fun bounty [“Race a BTC trading bot live for 24 hours”](https://make.fun/bounty/btc-race-24h-20261123-0511). Long-only cbBTC/USDC on 1-minute bars, $1,000 paper capital. Built with Muse only (Codex accounts dead, Xingchi 503).

## Strategy

Ride the day's main trend and nothing else.

### Entry rules

- **Confirmed trend change:** EMA(12) crosses above EMA(32) within the
  last 48 bars (`CROSS_MEMORY_BARS`) **and** the trailing 24-bar return is
  at least +50 bps (`MIN_RETURN_BPS`, window `RETURN_WINDOW_BARS`). The
  confirmation is what keeps a dead-cat bounce in a downtrend from
  triggering a buy.
- **Full size:** a signal buy spends all available cash
  (`notional_quote_units: state.cash`).
- **Re-entry guard:** after an exit, the next buy only fires above the
  last exit price + 50 bps (`REENTRY_GAP_BPS`) — never chase a falling
  market back in at or below where the stop just took us out.
- **At most 3 entries per window** (`MAX_ENTRIES`). Entries are counted
  when a position actually opens, so a rejected buy never burns an entry.
- **Probe fallback:** if no trade has happened by bar 1300
  (`PROBE_BAR`, compact index), buy a 10% slice of cash (`PROBE_PCT`) so
  the >=1-trade guardrail is met even in a window with no trend signal.
- **No buys at or after bar 1420** (`NO_BUY_AFTER`, compact index), and
  never below $1 of cash (`MIN_CASH_QUOTE_UNITS` = 1,000,000 quote
  micro-units). Everything still held is flattened by the harness at the
  end of the window.

### Exit rules

- **Trailing stop:** sell everything when the position's mark falls to
  2.5% below its peak mark (`TRAIL_BPS` = 250 bps).
- **Hard stop:** sell everything when the mark falls to 3.0% below cost
  (`STOP_BPS` = 300 bps).
- All orders use `max_slippage_bps: 100` (`MAX_SLIPPAGE_BPS`).

### Constants

| constant | value | meaning |
|---|---|---|
| `FAST_SPAN` | 12 | fast EMA span (bars) |
| `SLOW_SPAN` | 32 | slow EMA span (bars) |
| `TRAIL_BPS` | 250 | trailing stop from peak mark, bps |
| `STOP_BPS` | 300 | hard stop from cost, bps |
| `MIN_RETURN_BPS` | 50 | min trailing 24-bar return to enter, bps |
| `RETURN_WINDOW_BARS` | 24 | trailing-return confirmation window, bars |
| `CROSS_MEMORY_BARS` | 48 | a cross-up stays actionable this many bars |
| `MAX_ENTRIES` | 3 | most positions opened in one window |
| `REENTRY_GAP_BPS` | 50 | re-entry only above last exit + this, bps |
| `PROBE_BAR` | 1300 | probe buy fires at/after this bar if no trade yet |
| `PROBE_PCT` | 10 | probe buys this % of cash |
| `NO_BUY_AFTER` | 1420 | no new buys at/after this bar |
| `MIN_CASH_QUOTE_UNITS` | 1,000,000 | min cash ($1) to open a buy |
| `MAX_SLIPPAGE_BPS` | 100 | slippage cap on every order, bps |
| `BPS_DENOMINATOR` | 10000 | denominator for basis-point math |
| `PCT_DENOMINATOR` | 100 | denominator for percent math |

## Why this shape

The dev window is a smooth +3.6% uptrend, so buy-early-and-hold wins on
dev — but the race window is unseen. An unfiltered EMA-cross rider churns
(the kit's ema-cross baseline lost money on 76 trades), and in a mirrored
downtrend it loses MORE than buy-and-hold (repeated bounce entries, each
stopped out). The +50 bps confirmation plus the re-entry-above-exit-price
rule cut the mirrored-downtrend loss from -$33 to -$9.73 while keeping
+$30.74 of the dev upside.

## Validation

### grade-local (fresh kit, process driver, 2 runs byte-identical)

| metric | value |
|---|---|
| net PnL | **+$30.74** (30,737,933 micro-units) |
| max drawdown | 1.98% (0.019778195) |
| trades | 1 |
| fees | $0.81 |
| eligibility.ranked | true |
| flags | [] |
| action_log_sha256 | `b1948493cbb2e9b2d6b66946d4ea2965edbf774c07196e0e395ccc5eb5da2be8` |

Dev gate (PnL > 0, >= 1 trade, maxDD <= 25%) passes with margin.

### Robustness (simulator with exact integer fill math, replicated from the harness source; same params as above)

| window | PnL | trades | maxDD |
|---|---|---|---|
| dev | +$30.74 | 1 | 2.0% |
| mirror | -$9.73 | 1 | 2.2% |
| reverse | -$23.94 | 2 | 2.4% |
| shuffle median (10x) | +$29.78 | — | — |
| shuffle min (10x) | +$22.21 | — | — |

House best baseline (momentum) is +$34.94 on dev but has no loss cap: it
loses the full -3.6% on a mirrored window, while this bot caps that at
about -1%. A full-size round trip costs ~26 bps (4 fee + 2 slippage + ~7
impact each way at frozen depth); the bot only trades when the expected
move clears that by an order of magnitude.

## Determinism

Pure function of the bar stream. No clock, no environment, no
`Math.random`. EMAs are plain float arithmetic on the bar closes, and the
24-bar return and re-entry checks are exact BigInt comparisons, so two
runs on the same data produce byte-identical action logs. The refactor
that introduced the named constants changed no logic, threshold, or order
of operations: grade-local after the refactor reproduces the identical
action_log_sha256 above.

## Verify

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree --json --save <out>
```

Run twice; the two action logs must match byte for byte (determinism).
Expected: net PnL 30737933, maxDD 0.019778195, 1 trade,
action_log_sha256
`b1948493cbb2e9b2d6b66946d4ea2965edbf774c07196e0e395ccc5eb5da2be8`.

## Files

- `main.ts` — the whole strategy (fresh code, written in this session).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim
  (sha256 `9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).

## What is still unproven

- The race window is unseen: the edge is the trailing stop (caps a
  downtrend loss at ~2.5-3% per round trip) plus the confirmation filter
  (keeps the bot flat through bounces). If the race window whipsaws
  sideways, the bot may end near $0 with 1-2 small losing round trips.
- `grade-local` runs on Node 24 here vs the grader's Node 22.23.4; float
  EMA arithmetic is IEEE 754 in both, so the signals are identical, but
  the official grade is the only proof.

# TrendRider — btc-race-24h-20261123-0511

A BTC trend-following bot for the make.fun bounty "Race a BTC trading bot
live for 24 hours". Long-only cbBTC/USDC on 1-minute bars, $1,000 paper
capital. Built with Muse only (Codex accounts dead, Xingchi 503).

## Strategy

Ride the day's main trend and nothing else.

- **Enter** full-size only on a confirmed trend change: EMA(12) crosses
  above EMA(32) within the last 48 bars **and** the trailing 24-bar return
  is at least +50 bps. The confirmation is what keeps a dead-cat bounce in
  a downtrend from triggering a buy.
- **Exit** on a 2.5% trailing stop from the position's peak mark, or a 3.0%
  hard stop from cost. At most 3 entries per window.
- **Probe fallback:** if no signal ever fires, buy a 10% slice at bar 1300
  so the >=1-trade guardrail is met. No buys after bar 1420.
- Orders use `max_slippage_bps: 100`; entries are counted when a position
  actually opens, so a rejected buy never burns an entry.

## Why this shape

The dev window is a smooth +3.6% uptrend, so buy-early-and-hold wins on
dev — but the race window is unseen. An unfiltered EMA-cross rider churns
(the kit's ema-cross baseline lost money on 76 trades), and in a mirrored
downtrend it loses MORE than buy-and-hold (repeated bounce entries, each
stopped out). The +50 bps confirmation plus the re-entry-above-exit-price
rule cut the mirrored-downtrend loss from -$33 to -$9.73 while keeping
+$30.74 of the dev upside.

## Validation (simulator with exact integer fill math, replicated from the
## harness source; params fast 12 / slow 32 / trail 250 / stop 300 /
## return >= 50 bps / cross memory 48 / max 3 entries)

| window   | PnL    | trades | maxDD |
|----------|--------|--------|-------|
| dev      | +$30.74 | 1     | 2.0%  |
| mirror   | -$9.73  | 1     | 2.2%  |
| reverse  | -$23.94 | 2     | 2.4%  |
| shuffle median (10x) | +$29.78 | — | — |
| shuffle min (10x)    | +$22.21 | — | — |

House best baseline (momentum) is +$34.94 on dev but has no loss cap: it
loses the full -3.6% on a mirrored window, while this bot caps that at
about -1%. Dev gate (PnL > 0, >= 1 trade, maxDD <= 25%) passes with
margin. A full-size round trip costs ~26 bps (4 fee + 2 slippage + ~7
impact each way at frozen depth).

## Verify

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --json
```

Run twice; the two action logs must match byte for byte (determinism).

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

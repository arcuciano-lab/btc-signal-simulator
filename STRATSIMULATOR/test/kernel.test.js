import test from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/kernel.js";
import { syntheticBtcCandles } from "../src/fixture.js";
import { movingAverageStrategy } from "../src/strategies.js";

test("same inputs produce identical output", () => {
  const input = { marketData: syntheticBtcCandles, strategy: movingAverageStrategy({ period: 2 }) };
  assert.deepEqual(runBacktest(input), runBacktest(input));
});

test("fees and slippage reduce final equity", () => {
  const alwaysLong = { id: "always-long", decide: () => "long" };
  const free = runBacktest({ marketData: syntheticBtcCandles, strategy: alwaysLong });
  const costly = runBacktest({ marketData: syntheticBtcCandles, strategy: alwaysLong,
    feeRate: 0.002, slippageRate: 0.003 });
  assert.ok(costly.metrics.finalEquity < free.metrics.finalEquity);
  assert.equal(costly.metrics.tradeCount, 1);
});

test("strategy cannot see future candles and fills on next open", () => {
  const seen = [];
  const spy = { id: "spy", decide({ candle, history }) {
    seen.push({ candleTime: candle.time, lastTime: history.at(-1).time, length: history.length });
    return history.length === 1 ? "long" : "flat";
  }};
  const result = runBacktest({ marketData: syntheticBtcCandles, strategy: spy });
  assert.deepEqual(seen.map(x => x.length), [1, 2, 3, 4, 5, 6]);
  assert.ok(seen.every(x => x.candleTime === x.lastTime));
  assert.equal(result.trades[0].fillTime, syntheticBtcCandles[1].time);
  assert.equal(result.trades[0].price, syntheticBtcCandles[1].open);
});

test("rejects invalid timestamps, non-positive OHLC, and unordered data", () => {
  const flat = { decide: () => "flat" };
  const valid = [
    { time: 1, open: 100, high: 101, low: 99, close: 100 },
    { time: 2, open: 100, high: 101, low: 99, close: 100 }
  ];
  for (const invalid of [
    [{ ...valid[0], time: Number.NaN }, valid[1]],
    [{ ...valid[0], close: 0 }, valid[1]],
    [valid[0], { ...valid[1], time: 1 }]
  ]) assert.throws(() => runBacktest({ marketData: invalid, strategy: flat }));
});

test("an open position is force-closed at the final close", () => {
  const result = runBacktest({ marketData: syntheticBtcCandles,
    strategy: { decide: () => "long" } });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].forced, true);
  assert.equal(result.trades[0].exitTime, syntheticBtcCandles.at(-1).time);
  assert.equal(result.metrics.finalEquity, result.equityCurve.at(-1).equity);
});

test("cost arithmetic matches exact entry and forced-exit formula", () => {
  const data = [
    { time: 1, open: 100, high: 100, low: 100, close: 100 },
    { time: 2, open: 100, high: 100, low: 100, close: 100 }
  ];
  const result = runBacktest({ marketData: data, strategy: { decide: () => "long" },
    initialCash: 10_000, feeRate: 0.01, slippageRate: 0.02 });
  const quantity = 10_000 / (102 * 1.01);
  const expected = quantity * 98 * 0.99;
  assert.ok(Math.abs(result.metrics.finalEquity - expected) < 1e-9);
  assert.ok(Math.abs(result.trades[0].fee - quantity * 102 * 0.01) < 1e-9);
  assert.ok(Math.abs(result.trades[0].exitFee - quantity * 98 * 0.01) < 1e-9);
});

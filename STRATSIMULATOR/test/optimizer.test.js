import test from "node:test";
import assert from "node:assert/strict";
import { syntheticBtcCandles } from "../src/fixture.js";
import { optimizeSma, validationFitness } from "../src/optimizer.js";

const options = { marketData: syntheticBtcCandles, minPeriod: 1, maxPeriod: 3,
  trainRatio: 4 / 7, feeRate: 0.001, slippageRate: 0.0005,
  fitness: { drawdownWeight: 1.5, minTrades: 1, missingTradePenalty: 0.1 } };

test("optimization and champion selection are reproducible", () => {
  const first = optimizeSma(options);
  const second = optimizeSma(options);
  assert.deepEqual(first, second);
  assert.equal(first.champion.fitness, Math.max(...first.candidates.map(x => x.fitness)));
  assert.equal(first.objective.selection, "validation");
});

test("candidate periods remain inside inclusive integer bounds", () => {
  const result = optimizeSma(options);
  assert.deepEqual(result.candidates.map(x => x.params.period).sort(), [1, 2, 3]);
  assert.throws(() => optimizeSma({ ...options, minPeriod: 0 }));
  assert.throws(() => optimizeSma({ ...options, minPeriod: 3, maxPeriod: 2 }));
});

test("temporal split is chronological and non-overlapping", () => {
  const { split } = optimizeSma(options);
  assert.equal(split.train.count + split.validation.count, syntheticBtcCandles.length);
  assert.ok(split.train.end < split.validation.start);
  assert.equal(split.train.end, syntheticBtcCandles[split.splitIndex - 1].time);
  assert.equal(split.validation.start, syntheticBtcCandles[split.splitIndex].time);
});

test("fitness explicitly penalizes drawdown and missing trades", () => {
  const base = { return: 0.1, maxDrawdown: 0, tradeCount: 2 };
  const config = { drawdownWeight: 2, minTrades: 2, missingTradePenalty: 0.03 };
  assert.equal(validationFitness(base, config), 0.1);
  assert.ok(Math.abs(validationFitness({ ...base, maxDrawdown: 0.02 }, config) - 0.06) < 1e-12);
  assert.ok(Math.abs(validationFitness({ ...base, tradeCount: 0 }, config) - 0.04) < 1e-12);
});

test("normalizes chronology before splitting", () => {
  const candle = time => ({ time, open: 100, high: 100, low: 100, close: 100 });
  assert.throws(() => optimizeSma({ marketData: [candle(1), candle(4), candle(2), candle(3)],
    minPeriod: 1, maxPeriod: 1, trainRatio: 0.5 }));
});

test("rejects invalid objectives and traces effective defaults", () => {
  for (const fitness of [{ drawdownWeight: -1 }, { missingTradePenalty: Infinity },
    { minTrades: 1.5 }]) assert.throws(() => optimizeSma({ ...options, fitness }));
  assert.throws(() => validationFitness({ return: Infinity, maxDrawdown: 0, tradeCount: 1 }));
  const { objective } = optimizeSma({ ...options, fitness: undefined });
  assert.deepEqual(objective, { selection: "validation", drawdownWeight: 1,
    minTrades: 1, missingTradePenalty: 0.05 });
});

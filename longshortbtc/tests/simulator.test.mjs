import test from "node:test";
import assert from "node:assert/strict";
import { WEIGHTS } from "../strategy.js";
import { createSimulator, getMarkToMarket, processSimulator, TIMEFRAMES } from "../simulator.js";

const parts = Object.fromEntries(Object.keys(WEIGHTS).map(key => [key, .2]));

function market(score = 80, close = 100, closeTime = 1_000) {
  return Object.fromEntries(TIMEFRAMES.map(timeframe => [timeframe, {
    long:score,
    short:100 - score,
    parts,
    close,
    closeTime
  }]));
}

test("the simulator opens only one position for the same extreme candle", () => {
  const simulator = createSimulator(123);
  const current = market();
  const rows = { "5m":[] };
  processSimulator(simulator, current, rows);
  assert.equal(simulator.position.side, "long");
  assert.equal(simulator.position.entry, 100);
  assert.equal(simulator.startedAt, 123);
  const firstPosition = simulator.position;
  processSimulator(simulator, current, rows);
  assert.equal(simulator.position, firstPosition);
});

test("a stop wins deterministically when stop and target occur in the same candle", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(), { "5m":[] });
  const next = market(50, 102, 2_000);
  processSimulator(simulator, next, { "5m":[{ time:1_001, closeTime:2_000, low:97, high:106 }] });
  assert.equal(simulator.position, null);
  assert.equal(simulator.trades.length, 1);
  assert.equal(simulator.trades[0].reason, "Stop 2,5%");
  assert.equal(simulator.trades[0].exit, 97.5);
  assert.ok(simulator.bank < simulator.initialBank);
});

test("a persisted position pauses when the available history contains a gap", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(), { "5m":[] });
  const result = processSimulator(simulator, market(80, 101, 20_000), {
    "5m":[{ time:10_000, closeTime:20_000, low:99, high:102 }]
  });
  assert.equal(result.paused, true);
  assert.equal(simulator.position.dataGap, true);
  assert.equal(simulator.trades.length, 0);
});

test("mark-to-market includes the round-trip fee without mutating the bank", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(), { "5m":[] });
  const mark = getMarkToMarket(simulator, { close:105 });
  assert.ok(Math.abs(mark.pct - 4.8) < 1e-10);
  assert.ok(Math.abs(mark.pnl - 48) < 1e-10);
  assert.equal(simulator.bank, 1000);
});

test("a long position closes at its target and normalizes learned weights", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(), { "5m":[] });
  processSimulator(simulator, market(50, 104, 2_000), {
    "5m":[{ time:1_001, closeTime:2_000, low:99, high:105 }]
  });
  assert.equal(simulator.position, null);
  assert.equal(simulator.trades[0].reason, "Objetivo 5%");
  assert.equal(simulator.trades[0].exit, 105);
  assert.equal(simulator.learningSteps, 1);
  const weightTotal = Object.values(simulator.weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(weightTotal - 100) < 1e-10);
});

test("an opposite multi-timeframe signal closes an open position", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(), { "5m":[] });
  processSimulator(simulator, market(20, 99, 2_000), {
    "5m":[{ time:1_001, closeTime:2_000, low:98, high:101 }]
  });
  assert.equal(simulator.trades[0].reason, "Señal contraria");
  assert.equal(simulator.trades[0].exit, 99);
  assert.equal(simulator.position.side, "short");
});

test("a short position uses the inverse target calculation", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(20), { "5m":[] });
  assert.equal(simulator.position.side, "short");
  processSimulator(simulator, market(50, 96, 2_000), {
    "5m":[{ time:1_001, closeTime:2_000, low:95, high:101 }]
  });
  assert.equal(simulator.trades[0].reason, "Objetivo 5%");
  assert.equal(simulator.trades[0].exit, 95);
  assert.ok(simulator.trades[0].net > 0);
});

test("the checkpoint advances once and prevents evaluating the same candle twice", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(), { "5m":[] });
  const current = market(50, 101, 2_000);
  const rows = { "5m":[{ time:1_001, closeTime:2_000, low:99, high:102 }] };
  processSimulator(simulator, current, rows);
  assert.equal(simulator.position.lastEvaluatedCloseTime, 2_000);
  processSimulator(simulator, current, rows);
  assert.equal(simulator.position.lastEvaluatedCloseTime, 2_000);
  assert.equal(simulator.trades.length, 0);
});

test("the current behavior reopens on a new extreme candle after closing", () => {
  const simulator = createSimulator();
  processSimulator(simulator, market(80, 100, 1_000), { "5m":[] });
  processSimulator(simulator, market(80, 105, 2_000), {
    "5m":[{ time:1_001, closeTime:2_000, low:99, high:105 }]
  });
  assert.equal(simulator.trades.length, 1);
  assert.equal(simulator.position.side, "long");
  assert.equal(simulator.position.entry, 105);
  assert.equal(simulator.position.entryTime, 2_000);
});

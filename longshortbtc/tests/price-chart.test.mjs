import test from "node:test";
import assert from "node:assert/strict";
import { calculateCandleBodyGeometry, calculateCandlePriceDomain, selectVisibleCandles } from "../price-chart.js";

test("selectVisibleCandles returns exactly the latest 120 candles", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ index }));
  const visible = selectVisibleCandles(rows);

  assert.equal(visible.length, 120);
  assert.equal(visible[0].index, 80);
  assert.equal(visible.at(-1).index, 199);
});

test("selectVisibleCandles keeps all candles when fewer than 120 exist", () => {
  const rows = Array.from({ length: 37 }, (_, index) => ({ index }));
  assert.deepEqual(selectVisibleCandles(rows), rows);
});

test("price domain is derived only from visible candle highs and lows", () => {
  const rows = [
    { low: 99, high: 101 },
    { low: 100, high: 103 }
  ];
  const domain = calculateCandlePriceDomain(rows);

  assert.ok(domain.min < 99);
  assert.ok(domain.max > 103);
  assert.ok(domain.min > 90);
  assert.ok(domain.max < 110);
});

test("flat candle domains remain finite and readable", () => {
  const domain = calculateCandlePriceDomain([{ low: 100, high: 100 }]);
  assert.ok(Number.isFinite(domain.min));
  assert.ok(Number.isFinite(domain.max));
  assert.ok(domain.min < 100);
  assert.ok(domain.max > 100);
});

test("price domain uses compact four-percent padding without excluding candle extremes", () => {
  assert.deepEqual(calculateCandlePriceDomain([{ low: 100, high: 200 }]), { min: 96, max: 204 });
});

test("small candle bodies remain centered and readable", () => {
  assert.deepEqual(calculateCandleBodyGeometry(50, 50.5, 2), { top: 49.25, height: 2 });
  assert.equal(calculateCandleBodyGeometry(Number.NaN, 50), null);
});

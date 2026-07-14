import test from "node:test";
import assert from "node:assert/strict";
import { formatVolumeRatio, formatWinRate, getVolumeConfirmationLabel } from "../dashboard-format.js";

test("volume ratio uses the Spanish decimal separator and multiplication sign", () => {
  assert.equal(formatVolumeRatio(0.43), "0,43\u00D7");
  assert.equal(formatVolumeRatio(1.1), "1,10\u00D7");
});

test("volume confirmation keeps the 1.1 threshold", () => {
  assert.equal(getVolumeConfirmationLabel(1.099), "Confirmaci\u00f3n d\u00e9bil");
  assert.equal(getVolumeConfirmationLabel(1.1), "Volumen confirma");
});

test("win rate uses closed wins over closed trades", () => {
  assert.equal(formatWinRate(2, 3), "66,7%");
  assert.equal(formatWinRate(0, 4), "0,0%");
});

test("win rate displays an em dash when there are no closed trades", () => {
  assert.equal(formatWinRate(0, 0), "\u2014");
});

test("formatters degrade safely for non-finite input", () => {
  assert.equal(formatVolumeRatio(Number.NaN), "\u2014");
  assert.equal(formatWinRate(Number.NaN, 2), "\u2014");
});

test("volume ratio rejects impossible negative values", () => {
  assert.equal(formatVolumeRatio(-0.01), "\u2014");
  assert.equal(formatVolumeRatio(0), "0,00\u00D7");
});

test("win rate rejects fractional, negative and contradictory counts", () => {
  assert.equal(formatWinRate(1.5, 2), "\u2014");
  assert.equal(formatWinRate(1, 2.5), "\u2014");
  assert.equal(formatWinRate(-1, 2), "\u2014");
  assert.equal(formatWinRate(3, 2), "\u2014");
  assert.equal(formatWinRate(0, -1), "\u2014");
});

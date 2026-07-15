import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildActiveTradePanel } from "../active-trade-panel.js";

function position(overrides = {}) {
  return {
    side: "long",
    baselineEquity: 1000,
    effectiveFloor: 900,
    weightedAverage: 100,
    riskBoundary: 90,
    totalNotional: 100,
    remainingFraction: .75,
    partials: [{ sequence: 1, fraction: .25, notional: 25, fillPrice: 110, price: 110, time: 2, reason: "Structural partial: Resistance" }],
    structuralPartials: [
      { order: 1, level: 109, reason: "Resistance", executed: true, executedAt: 2 },
      { order: 2, level: 115, reason: "EMA 200", executed: false }
    ],
    ...overrides
  };
}

test("active panel keeps an executed structural partial visible with actual fill and cumulative close", () => {
  const panel = buildActiveTradePanel(position(), { markPrice: 105, equity: 980 });
  assert.match(panel.text, /TP PARCIAL 1\s+FILLED 110\.00 US\$ \| CERRADO 25\.0%/);
  assert.match(panel.text, /TP PARCIAL 2\s+PENDING 115\.00 US\$/);
  assert.match(panel.text, /TP TOTAL\s+DYNAMIC RUNNER \| CERRADO 25\.0% \| RESTA 75\.0%/);
  assert.match(panel.text, /SL HARD -10%\s+90\.00 US\$/);
  assert.equal(panel.tone, "normal");
});

test("risk tones are presentation-only bands derived from actual equity distance", () => {
  assert.equal(buildActiveTradePanel(position(), { markPrice: 92, equity: 925 }).tone, "warning");
  const critical = buildActiveTradePanel(position(), { markPrice: 91, equity: 905 });
  assert.equal(critical.tone, "critical");
  assert.match(critical.text, /95% DEL LIMITE \(AVISO VISUAL\)/);
  const clamped = buildActiveTradePanel(position(), { markPrice: 89, equity: 850 });
  assert.match(clamped.text, /100% DEL LIMITE \(AVISO VISUAL\)/);
});

test("aggregate totals keep one current denominator when a leg is added after a partial", () => {
  const panel = buildActiveTradePanel(position({ totalNotional: 200, remainingFraction: .875 }), { markPrice: 105, equity: 980 });
  assert.match(panel.text, /TP PARCIAL 1\s+FILLED 110\.00 US\$ \| CERRADO 12\.5%/);
  assert.match(panel.text, /TP TOTAL\s+DYNAMIC RUNNER \| CERRADO 12\.5% \| RESTA 87\.5%/);
});

test("unavailable risk inputs never present a fabricated zero-percent risk state", () => {
  for (const overrides of [
    { baselineEquity: undefined },
    { baselineEquity: Number.NaN },
    { effectiveFloor: 1000 }
  ]) {
    const panel = buildActiveTradePanel(position(overrides), { markPrice: 105, equity: 980 });
    assert.equal(panel.tone, "unknown");
    assert.match(panel.text, /USO DE RIESGO\s+NO DISPONIBLE/);
    assert.doesNotMatch(panel.text, /0% DEL LIMITE/);
  }
  const missingEquity = buildActiveTradePanel(position(), { markPrice: 105 });
  assert.equal(missingEquity.tone, "unknown");
  assert.match(missingEquity.text, /USO DE RIESGO\s+NO DISPONIBLE/);
  for (const equity of [0, Number.NaN]) {
    const panel = buildActiveTradePanel(position(), { markPrice: 105, equity });
    assert.equal(panel.tone, "unknown");
    assert.match(panel.text, /USO DE RIESGO\s+NO DISPONIBLE/);
  }
});

test("idle panel is honest and structural reasons remain plain formatter output", () => {
  assert.match(buildActiveTradePanel(null).text, /SIN OPERACION ACTIVA/);
  const text = buildActiveTradePanel(position({ structuralPartials: [{ level: 115, reason: "<img onerror=alert(1)>", executed: false }], partials: [], remainingFraction: 1 }), { markPrice: 105, equity: 1000 }).text;
  assert.match(text, /<img onerror=alert\(1\)>/);
});

test("browser integration assigns panel output through textContent", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /tradePanel\.textContent = panel\.text/);
  assert.doesNotMatch(app, /tradePanel\.innerHTML/);
});

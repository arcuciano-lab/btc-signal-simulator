import { syntheticBtcCandles } from "./fixture.js";
import { optimizeSma } from "./optimizer.js";

const trace = optimizeSma({ marketData: syntheticBtcCandles, minPeriod: 1,
  maxPeriod: 3, trainRatio: 4 / 7, feeRate: 0.001, slippageRate: 0.0005,
  fitness: { drawdownWeight: 1.5, minTrades: 1, missingTradePenalty: 0.1 } });
console.log(JSON.stringify(trace, null, 2));

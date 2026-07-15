import { runBacktest } from "./kernel.js";
import { syntheticBtcCandles } from "./fixture.js";
import { movingAverageStrategy } from "./strategies.js";

const result = runBacktest({ marketData: syntheticBtcCandles,
  strategy: movingAverageStrategy({ period: 2 }), feeRate: 0.001, slippageRate: 0.0005 });
console.log(JSON.stringify(result, null, 2));

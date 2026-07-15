import { normalizeCandles, runBacktest } from "./kernel.js";
import { movingAverageStrategy } from "./strategies.js";

function normalizeFitness({ drawdownWeight = 1, minTrades = 1,
  missingTradePenalty = 0.05 } = {}) {
  if (!Number.isFinite(drawdownWeight) || drawdownWeight < 0 ||
      !Number.isFinite(missingTradePenalty) || missingTradePenalty < 0 ||
      !Number.isInteger(minTrades) || minTrades < 0)
    throw new RangeError("invalid fitness configuration");
  return Object.freeze({ drawdownWeight, minTrades, missingTradePenalty });
}

export function validationFitness(metrics, options = {}) {
  const { drawdownWeight, minTrades, missingTradePenalty } = normalizeFitness(options);
  const tradeShortfall = Math.max(0, minTrades - metrics.tradeCount);
  const score = metrics.return - drawdownWeight * metrics.maxDrawdown -
    missingTradePenalty * tradeShortfall;
  if (!Number.isFinite(score)) throw new RangeError("fitness must be finite");
  return score;
}

/** Exhaustive, deterministic parameter search. Each evaluation gets a fresh strategy. */
export function optimizeSma({ marketData, minPeriod = 1, maxPeriod = 5,
  trainRatio = 0.6, initialCash = 10_000, feeRate = 0, slippageRate = 0,
  fitness = {}, strategyFactory = movingAverageStrategy }) {
  const data = normalizeCandles(marketData);
  if (!Number.isInteger(minPeriod) || !Number.isInteger(maxPeriod) ||
      minPeriod < 1 || maxPeriod < minPeriod)
    throw new RangeError("invalid period bounds");
  if (!(trainRatio > 0 && trainRatio < 1)) throw new RangeError("trainRatio must be between 0 and 1");
  const splitIndex = Math.floor(data.length * trainRatio);
  const train = data.slice(0, splitIndex);
  const validation = data.slice(splitIndex);
  if (train.length < 2 || validation.length < 2)
    throw new RangeError("train and validation splits require at least two candles each");
  const config = { initialCash, feeRate, slippageRate };
  const objective = normalizeFitness(fitness);
  const candidates = [];
  for (let period = minPeriod; period <= maxPeriod; period++) {
    const params = Object.freeze({ period });
    // Separate instances prevent state learned on train from leaking into validation.
    const trainResult = runBacktest({ marketData: train, strategy: strategyFactory(params), ...config });
    const validationResult = runBacktest({ marketData: validation,
      strategy: strategyFactory(params), ...config });
    candidates.push(Object.freeze({ params, train: trainResult.metrics,
      validation: validationResult.metrics,
      fitness: validationFitness(validationResult.metrics, objective) }));
  }
  candidates.sort((a, b) => b.fitness - a.fitness || a.params.period - b.params.period);
  return Object.freeze({
    split: Object.freeze({ splitIndex,
      train: Object.freeze({ start: train[0].time, end: train.at(-1).time, count: train.length }),
      validation: Object.freeze({ start: validation[0].time,
        end: validation.at(-1).time, count: validation.length }) }),
    objective: Object.freeze({ selection: "validation", ...objective }),
    candidates: Object.freeze(candidates), champion: candidates[0]
  });
}

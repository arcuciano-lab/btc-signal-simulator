import { WEIGHTS } from "./strategy.js";

export const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
export const SIMULATOR_VERSION = 2;
export const STRATEGY_VERSION = "adaptive-neutral-v1";

const TF_INFLUENCE = { "5m": .15, "15m": .20, "1h": .30, "4h": .35 };
const FEE_RATE = .002;
const PARTIAL_FRACTION = .5;
const FIVE_MINUTES = 5 * 60 * 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(value);

function learningMetadata(steps = 0) {
  return {
    version: 1,
    strategyVersion: STRATEGY_VERSION,
    algorithm: "bounded-normalized-reward-v1",
    rewardClip: 1,
    initialEta: .04,
    regularization: .015,
    steps
  };
}

export function createSimulator(now = Date.now()) {
  return {
    version: SIMULATOR_VERSION,
    initialBank: 1000,
    bank: 1000,
    position: null,
    pendingReversal: null,
    trades: [],
    weights: { ...WEIGHTS },
    learningSteps: 0,
    learning: learningMetadata(),
    lastEntryKey: null,
    startedAt: now
  };
}

function validWeights(weights) {
  return weights && Object.keys(WEIGHTS).every(key => finite(weights[key]) && weights[key] > 0);
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (!finite(total) || total <= 0) return { ...WEIGHTS };
  return Object.fromEntries(Object.keys(WEIGHTS).map(key => [key, weights[key] / total * 100]));
}

function projectWeights(weights) {
  const keys = Object.keys(WEIGHTS);
  const lower = Object.fromEntries(keys.map(key => [key, WEIGHTS[key] * .60]));
  const upper = Object.fromEntries(keys.map(key => [key, WEIGHTS[key] * 1.40]));
  const projected = { ...weights };
  let free = new Set(keys);
  let remaining = 100;
  while (free.size) {
    const total = [...free].reduce((sum, key) => sum + projected[key], 0);
    let constrained = false;
    for (const key of [...free]) {
      const candidate = total > 0 ? projected[key] / total * remaining : remaining / free.size;
      if (candidate < lower[key] - 1e-12) {
        projected[key] = lower[key]; remaining -= lower[key]; free.delete(key); constrained = true;
      } else if (candidate > upper[key] + 1e-12) {
        projected[key] = upper[key]; remaining -= upper[key]; free.delete(key); constrained = true;
      }
    }
    if (!constrained) {
      const divisor = [...free].reduce((sum, key) => sum + projected[key], 0);
      for (const key of free) projected[key] = divisor > 0 ? projected[key] / divisor * remaining : remaining / free.size;
      break;
    }
  }
  return projected;
}

export function migrateSimulator(raw, now = Date.now()) {
  const fresh = createSimulator(now);
  if (!raw || typeof raw !== "object" || !finite(raw.bank) || raw.bank < 0 || !validWeights(raw.weights)) return fresh;
  const weights = projectWeights(normalizeWeights(raw.weights));
  const trades = Array.isArray(raw.trades) ? raw.trades.filter(trade => trade && finite(trade.net) && finite(trade.pnl)).slice(0, 200) : [];
  let position = null;
  if (raw.position && ["long", "short"].includes(raw.position.side) && finite(raw.position.entry) && raw.position.entry > 0 && finite(raw.position.entryTime)) {
    const migratedPartials = Array.isArray(raw.position.partials) ? raw.position.partials.filter(part => part && finite(part.pnl)) : [];
    const hasAuditablePartial = raw.position.partialTaken === true && migratedPartials.length > 0
      && finite(raw.position.remainingFraction) && raw.position.remainingFraction > 0 && raw.position.remainingFraction < 1;
    position = {
      ...raw.position,
      capital: finite(raw.position.capital) && raw.position.capital >= 0 ? raw.position.capital : raw.bank,
      remainingFraction: hasAuditablePartial ? raw.position.remainingFraction : 1,
      partialTaken: hasAuditablePartial,
      realizedPnl: hasAuditablePartial && finite(raw.position.realizedPnl) ? raw.position.realizedPnl : 0,
      partials: hasAuditablePartial ? migratedPartials : [],
      dataGap: raw.position.dataGap === true
    };
  }
  const steps = Number.isInteger(raw.learningSteps) && raw.learningSteps >= 0 ? raw.learningSteps : 0;
  return {
    ...fresh,
    initialBank: finite(raw.initialBank) && raw.initialBank > 0 ? raw.initialBank : fresh.initialBank,
    bank: raw.bank,
    position,
    pendingReversal: raw.pendingReversal && ["long", "short"].includes(raw.pendingReversal.side) && finite(raw.pendingReversal.requestedAt)
      ? { ...raw.pendingReversal } : null,
    trades,
    weights,
    learningSteps: steps,
    learning: { ...learningMetadata(steps), migratedFromVersion: finite(raw.learning?.version) ? raw.learning.version : null },
    lastEntryKey: typeof raw.lastEntryKey === "string" ? raw.lastEntryKey : null,
    startedAt: finite(raw.startedAt) ? raw.startedAt : now,
    version: SIMULATOR_VERSION
  };
}

export function getConsensus(currentByTf) {
  let long = 0;
  for (const timeframe of TIMEFRAMES) long += currentByTf[timeframe].long * TF_INFLUENCE[timeframe];
  long = Math.round(long);
  const short = 100 - long;
  const side = long >= short ? "long" : "short";
  const agreement = TIMEFRAMES.filter(timeframe => currentByTf[timeframe][side] >= 60).length;
  const parts = {};
  for (const key of Object.keys(WEIGHTS)) {
    parts[key] = TIMEFRAMES.reduce((sum, timeframe) => sum + currentByTf[timeframe].parts[key] * TF_INFLUENCE[timeframe], 0);
  }
  return { long, short, side, agreement, parts };
}

function returnFor(position, price) {
  return position.side === "long" ? price / position.entry - 1 : 1 - price / position.entry;
}

function oppositeSignal(position, signal, currentByTf) {
  const side = position.side === "long" ? "short" : "long";
  return {
    side,
    score: signal[side],
    agreement: TIMEFRAMES.filter(timeframe => currentByTf[timeframe][side] >= 60).length
  };
}

function learnFromTrade(simulator, trade) {
  const reward = clamp(trade.net / .05, -1, 1);
  const direction = trade.side === "long" ? 1 : -1;
  const eta = simulator.learning.initialEta / Math.sqrt(simulator.learningSteps + 1);
  const regularization = simulator.learning.regularization;
  const adjusted = {};
  for (const key of Object.keys(WEIGHTS)) {
    const alignment = clamp(trade.parts?.[key] * direction || 0, -1, 1);
    const learned = simulator.weights[key] * (1 + eta * reward * alignment);
    adjusted[key] = learned + regularization * (WEIGHTS[key] - learned);
  }
  simulator.weights = projectWeights(normalizeWeights(adjusted));
  simulator.learningSteps += 1;
  simulator.learning.steps = simulator.learningSteps;
  trade.learning = { reward, eta, weightsAfter: { ...simulator.weights }, metadataVersion: simulator.learning.version };
}

function realizeSlice(simulator, position, exit, fraction, final) {
  const gross = returnFor(position, exit.price);
  const net = gross - FEE_RATE;
  const pnl = position.capital * fraction * net;
  simulator.bank = Math.max(0, simulator.bank + pnl);
  position.realizedPnl += pnl;
  position.remainingFraction = Math.max(0, position.remainingFraction - fraction);
  const slice = { fraction, price: exit.price, time: exit.time, reason: exit.reason, gross, net, pnl };
  if (!final) {
    position.partialTaken = true;
    position.partials.push(slice);
    return;
  }
  const totalPnl = position.realizedPnl;
  const totalNet = position.capital > 0 ? totalPnl / position.capital : 0;
  const trade = {
    ...position,
    exit: exit.price,
    exitTime: exit.time,
    reason: exit.reason,
    gross,
    net: totalNet,
    pnl: totalPnl,
    bankAfter: simulator.bank
  };
  simulator.trades.unshift(trade);
  simulator.trades = simulator.trades.slice(0, 200);
  simulator.position = null;
  learnFromTrade(simulator, trade);
}

function openPosition(simulator, side, signal, currentByTf, market) {
  simulator.position = {
    side,
    entry: market.close,
    entryTime: market.closeTime,
    lastEvaluatedCloseTime: market.closeTime,
    capital: simulator.bank,
    remainingFraction: 1,
    partialTaken: false,
    partials: [],
    realizedPnl: 0,
    longScore: signal.long,
    shortScore: signal.short,
    agreement: signal.agreement,
    parts: signal.parts,
    timeframeScores: Object.fromEntries(TIMEFRAMES.map(timeframe => [timeframe, { long: currentByTf[timeframe].long, short: currentByTf[timeframe].short }]))
  };
  simulator.lastEntryKey = `${market.closeTime}-${side}`;
}

export function processSimulator(simulator, currentByTf, rowsByTf) {
  const signal = getConsensus(currentByTf);
  const market = currentByTf["5m"];
  let closedThisUpdate = false;
  if (simulator.position) {
    const position = simulator.position;
    const checkpoint = position.lastEvaluatedCloseTime ?? position.entryTime;
    const completed = rowsByTf["5m"].filter(candle => candle.closeTime > checkpoint);
    if (completed.length && completed[0].time > checkpoint + 1) {
      position.dataGap = true;
      return { changed: true, paused: true };
    }
    position.dataGap = false;
    let exit = null;
    for (const candle of completed) {
      const stopPrice = position.side === "long" ? position.entry * .975 : position.entry * 1.025;
      const targetPrice = position.side === "long" ? position.entry * 1.05 : position.entry * .95;
      const stopHit = position.side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice;
      const targetHit = position.side === "long" ? candle.high >= targetPrice : candle.low <= targetPrice;
      if (stopHit) { exit = { price: stopPrice, time: candle.closeTime, reason: "Stop 2.5%" }; break; }
      if (targetHit) { exit = { price: targetPrice, time: candle.closeTime, reason: "Target 5%" }; break; }
    }
    if (exit) {
      realizeSlice(simulator, position, exit, position.remainingFraction, true);
      closedThisUpdate = true;
    } else if (completed.length) {
      const ownScore = signal[position.side];
      const profitable = returnFor(position, market.close) > FEE_RATE;
      if (ownScore <= 55) {
        const reason = profitable ? "Neutral profit exit" : "Signal invalidation";
        realizeSlice(simulator, position, { price: market.close, time: market.closeTime, reason }, position.remainingFraction, true);
        closedThisUpdate = true;
      } else {
        if (!position.partialTaken && ownScore <= 62 && profitable) {
          realizeSlice(simulator, position, { price: market.close, time: market.closeTime, reason: "Partial profit at neutral approach" }, PARTIAL_FRACTION, false);
        }
        position.lastEvaluatedCloseTime = completed.at(-1).closeTime;
      }
    }
    if (closedThisUpdate) {
      const opposite = oppositeSignal(position, signal, currentByTf);
      if (opposite.score >= 75 && opposite.agreement >= 3) {
        simulator.pendingReversal = {
          side: opposite.side,
          requestedAt: market.closeTime,
          expectedNextCloseTime: market.closeTime + FIVE_MINUTES,
          score: opposite.score,
          agreement: opposite.agreement
        };
      }
    }
  }

  if (!simulator.position) {
    if (simulator.pendingReversal) {
      const pending = simulator.pendingReversal;
      const stillExtreme = signal[pending.side] >= 75 && TIMEFRAMES.filter(tf => currentByTf[tf][pending.side] >= 60).length >= 3;
      const expected = pending.expectedNextCloseTime ?? pending.requestedAt + FIVE_MINUTES;
      const hasExpectedClosedCandle = rowsByTf["5m"].some(candle => candle.closeTime === expected);
      if (market.closeTime === expected && hasExpectedClosedCandle && stillExtreme) {
        openPosition(simulator, pending.side, signal, currentByTf, market);
        simulator.pendingReversal = null;
      } else if (market.closeTime >= expected && (!hasExpectedClosedCandle || market.closeTime > expected || !stillExtreme)) {
        simulator.pendingReversal = null;
      }
    } else if (!closedThisUpdate) {
      const extreme = Math.max(signal.long, signal.short) >= 75 && signal.agreement >= 3;
      const entryKey = `${market.closeTime}-${signal.side}`;
      if (extreme && simulator.lastEntryKey !== entryKey) openPosition(simulator, signal.side, signal, currentByTf, market);
    }
  }
  return { changed: true, paused: false };
}

export function getMarkToMarket(simulator, market) {
  if (!simulator.position || !market) return { equity: simulator.bank, pnl: 0, pct: 0, realizedPnl: 0 };
  const position = simulator.position;
  const net = returnFor(position, market.close) - FEE_RATE;
  const pnl = position.capital * position.remainingFraction * net;
  return {
    equity: simulator.bank + pnl,
    pnl,
    pct: net * 100,
    realizedPnl: position.realizedPnl
  };
}

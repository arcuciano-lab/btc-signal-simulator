import { WEIGHTS } from "./strategy.js";

export const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
export const SIMULATOR_VERSION = 3;
export const STRATEGY_VERSION = "adaptive-neutral-leverage-v1";

const TF_INFLUENCE = { "5m": .15, "15m": .20, "1h": .30, "4h": .35 };
const FEE_RATE = .002;
const ESTIMATED_SLIPPAGE_RATE = .001;
const STOP_MOVE = .025;
const MAX_EQUITY_RISK = .02;
const PARTIAL_FRACTION = .5;
const FIVE_MINUTES = 5 * 60 * 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(value);
export const isValidCandle = candle => candle && ["time", "closeTime", "open", "high", "low", "close"]
  .every(key => finite(candle[key]) && candle[key] > 0)
  && candle.low <= Math.min(candle.open, candle.close)
  && candle.high >= Math.max(candle.open, candle.close)
  && candle.high >= candle.low && candle.closeTime >= candle.time;

function validInputs(currentByTf, rowsByTf) {
  return currentByTf && rowsByTf && TIMEFRAMES.every(timeframe => {
    const current = currentByTf[timeframe];
    return current && finite(current.long) && finite(current.short) && current.long >= 0 && current.short >= 0
      && current.long + current.short === 100 && finite(current.close) && current.close > 0 && finite(current.closeTime);
  }) && Array.isArray(rowsByTf["5m"]) && rowsByTf["5m"].every(isValidCandle);
}

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

function leverageMetadata() {
  return {
    version: 1,
    objective: "risk-adjusted-return-v1",
    closedTrades: 0,
    target: 1,
    lastLeverage: 1,
    lossStreak: 0,
    peakBank: 1000,
    drawdown: 0
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
    leverageLearning: leverageMetadata(),
    lastEntryKey: null,
    startedAt: now
  };
}

function validWeights(weights) {
  return weights && Object.keys(WEIGHTS).every(key => finite(weights[key]) && weights[key] > 0);
}

function boundedInteger(value, fallback, min, max) {
  return finite(value) ? clamp(Math.round(value), min, max) : fallback;
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
  const trades = Array.isArray(raw.trades) ? raw.trades.filter(trade => trade && finite(trade.net) && finite(trade.pnl)
    && ["long", "short"].includes(trade.side) && finite(trade.entry) && trade.entry > 0)
    .map(trade => ({
      ...trade,
      leverage: boundedInteger(trade.leverage, 1, 1, 10),
      netRoi: trade.net,
      pnlCurrency: trade.pnl,
      weightedAssetReturn: finite(trade.weightedAssetReturn) ? trade.weightedAssetReturn : finite(trade.assetReturn) ? trade.assetReturn : finite(trade.gross) ? trade.gross : null,
      legacyMetricsAuditable: finite(trade.weightedAssetReturn) || finite(trade.assetReturn)
    })).slice(0, 200) : [];
  let position = null;
  if (raw.position && ["long", "short"].includes(raw.position.side) && finite(raw.position.entry) && raw.position.entry > 0 && finite(raw.position.entryTime)) {
    const originalCapital = finite(raw.position.capital) ? raw.position.capital : raw.version >= 2 ? null : raw.bank;
    const legacyLeverage = boundedInteger(raw.position.leverage, 1, 1, 10);
    const rawPartials = Array.isArray(raw.position.partials) ? raw.position.partials : [];
    const migratedPartials = rawPartials.map(part => {
      const fraction = part?.fraction;
      const price = part?.price;
      const assetGross = finite(price) && price > 0
        ? raw.position.side === "long" ? price / raw.position.entry - 1 : 1 - price / raw.position.entry
        : null;
      const estimatedFee = finite(originalCapital) && finite(fraction) ? originalCapital * fraction * legacyLeverage * FEE_RATE : null;
      const estimatedSlippage = finite(originalCapital) && finite(fraction) ? originalCapital * fraction * legacyLeverage * ESTIMATED_SLIPPAGE_RATE : null;
      const netRoi = finite(assetGross) ? assetGross * legacyLeverage - legacyLeverage * (FEE_RATE + ESTIMATED_SLIPPAGE_RATE) : null;
      const pnlCurrency = finite(originalCapital) && finite(fraction) && finite(netRoi) ? originalCapital * fraction * netRoi : null;
      return { fraction, price, time: part?.time, reason: part?.reason, assetGross, leverage: legacyLeverage,
        estimatedFee, estimatedSlippage, netRoi, pnlCurrency, pnl: pnlCurrency };
    });
    const fractionSum = migratedPartials.reduce((sum, part) => sum + (finite(part.fraction) ? part.fraction : 0), 0);
    const partialsValid = migratedPartials.every(part => finite(part.fraction) && part.fraction > 0 && part.fraction <= 1
      && finite(part.price) && part.price > 0 && finite(part.assetGross) && finite(part.pnlCurrency) && finite(part.estimatedFee) && part.estimatedFee >= 0
      && finite(part.estimatedSlippage) && part.estimatedSlippage >= 0)
      && fractionSum < 1 && finite(raw.position.remainingFraction)
      && Math.abs((1 - fractionSum) - raw.position.remainingFraction) <= 1e-9;
    const hasAuditablePartial = raw.position.partialTaken === true && migratedPartials.length > 0 && partialsValid;
    const cleanUnpartialed = raw.position.partialTaken !== true && migratedPartials.length === 0
      && (!finite(raw.position.remainingFraction) || Math.abs(raw.position.remainingFraction - 1) <= 1e-9);
    const positionValid = finite(originalCapital) && originalCapital > 0 && originalCapital <= raw.bank
      && (hasAuditablePartial || cleanUnpartialed);
    const reconstructedAssetReturn = hasAuditablePartial ? migratedPartials.reduce((sum, part) => sum + part.fraction * part.assetGross, 0) : 0;
    if (positionValid) position = {
      side: raw.position.side,
      entry: raw.position.entry,
      entryTime: raw.position.entryTime,
      lastEvaluatedCloseTime: finite(raw.position.lastEvaluatedCloseTime) ? Math.max(raw.position.entryTime, raw.position.lastEvaluatedCloseTime) : raw.position.entryTime,
      capital: originalCapital,
      legacyRiskPolicy: "grandfathered-existing-exposure-no-resize",
      remainingFraction: hasAuditablePartial ? raw.position.remainingFraction : 1,
      partialTaken: hasAuditablePartial,
      realizedPnl: hasAuditablePartial ? migratedPartials.reduce((sum, part) => sum + part.pnlCurrency, 0) : 0,
      partials: hasAuditablePartial ? migratedPartials : [],
      dataGap: raw.position.dataGap === true,
      leverage: legacyLeverage,
      leverageReason: typeof raw.position.leverageReason === "string" ? raw.position.leverageReason : "Migrated conservatively at 1x",
      maeAsset: finite(raw.position.maeAsset) ? Math.max(0, raw.position.maeAsset) : 0,
      mfeAsset: finite(raw.position.mfeAsset) ? Math.max(0, raw.position.mfeAsset) : 0,
      feesPaid: hasAuditablePartial ? migratedPartials.reduce((sum, part) => sum + part.estimatedFee, 0) : 0,
      estimatedSlippagePaid: hasAuditablePartial ? migratedPartials.reduce((sum, part) => sum + part.estimatedSlippage, 0) : 0,
      realizedAssetReturn: hasAuditablePartial ? reconstructedAssetReturn : 0,
      legacyMetricsAuditable: true,
      longScore: finite(raw.position.longScore) ? raw.position.longScore : null,
      shortScore: finite(raw.position.shortScore) ? raw.position.shortScore : null,
      agreement: boundedInteger(raw.position.agreement, 0, 0, 4),
      parts: raw.position.parts && typeof raw.position.parts === "object" ? raw.position.parts : {},
      timeframeScores: raw.position.timeframeScores && typeof raw.position.timeframeScores === "object" ? raw.position.timeframeScores : {},
      leverageDecision: raw.position.leverageDecision && typeof raw.position.leverageDecision === "object" ? raw.position.leverageDecision : null,
      regime: typeof raw.position.regime === "string" ? raw.position.regime : "unknown"
    };
  }
  const steps = Number.isInteger(raw.learningSteps) && raw.learningSteps >= 0 ? raw.learningSteps : 0;
  const leverageLearning = raw.version >= 3 && raw.leverageLearning && typeof raw.leverageLearning === "object"
    ? {
        ...leverageMetadata(),
        closedTrades: boundedInteger(raw.leverageLearning.closedTrades, 0, 0, Number.MAX_SAFE_INTEGER),
        target: boundedInteger(raw.leverageLearning.target, 1, 1, 10),
        lastLeverage: boundedInteger(raw.leverageLearning.lastLeverage, 1, 1, 10),
        lossStreak: boundedInteger(raw.leverageLearning.lossStreak, 0, 0, Number.MAX_SAFE_INTEGER),
        peakBank: finite(raw.leverageLearning.peakBank) ? Math.max(raw.bank, raw.leverageLearning.peakBank) : Math.max(raw.bank, fresh.initialBank),
        drawdown: finite(raw.leverageLearning.drawdown) ? clamp(raw.leverageLearning.drawdown, 0, 1) : 0
      }
    : { ...leverageMetadata(), peakBank: Math.max(raw.bank, fresh.initialBank) };
  return {
    ...fresh,
    initialBank: finite(raw.initialBank) && raw.initialBank > 0 ? raw.initialBank : fresh.initialBank,
    bank: raw.bank,
    position,
    pendingReversal: raw.pendingReversal && ["long", "short"].includes(raw.pendingReversal.side) && finite(raw.pendingReversal.requestedAt)
      ? { side: raw.pendingReversal.side, requestedAt: raw.pendingReversal.requestedAt,
          expectedNextCloseTime: raw.pendingReversal.requestedAt + FIVE_MINUTES,
          score: finite(raw.pendingReversal.score) ? raw.pendingReversal.score : null,
          agreement: boundedInteger(raw.pendingReversal.agreement, 0, 0, 4) } : null,
    trades,
    weights,
    learningSteps: steps,
    learning: { ...learningMetadata(steps), migratedFromVersion: finite(raw.learning?.version) ? raw.learning.version : null },
    leverageLearning,
    lastEntryKey: typeof raw.lastEntryKey === "string" ? raw.lastEntryKey : null,
    startedAt: finite(raw.startedAt) ? raw.startedAt : now,
    version: SIMULATOR_VERSION
  };
}

function volatilityProxy(market) {
  if (finite(market.bbUpper) && finite(market.bbLower) && market.close > 0) return clamp((market.bbUpper - market.bbLower) / market.close / 4, .005, .20);
  if (finite(market.high) && finite(market.low) && market.close > 0) return clamp((market.high - market.low) / market.close, .005, .20);
  return .03;
}

export function selectLeverage(simulator, signal, market) {
  const learning = simulator.leverageLearning;
  const score = Math.max(signal.long, signal.short);
  const volatility = volatilityProxy(market);
  const cold = learning.closedTrades < 5;
  const confidenceCap = score >= 95 && signal.agreement === 4 ? 10 : score >= 90 && signal.agreement === 4 ? 6 : score >= 84 ? 4 : 2;
  const volatilityCap = clamp(Math.floor(.20 / volatility), 1, 10);
  const circuitCap = learning.lossStreak >= 2 || learning.drawdown >= .10 ? 1 : 10;
  const coldCap = score >= 90 && signal.agreement === 4 && volatility <= .02 ? 2 : 1;
  const caps = { learned: cold ? coldCap : learning.target, confidence: confidenceCap, volatility: volatilityCap, circuit: circuitCap, hard: 10 };
  const leverage = clamp(Math.min(...Object.values(caps)), 1, 10);
  const bindingCap = Object.entries(caps).find(([, value]) => value === leverage)?.[0] || "hard";
  return {
    leverage, volatility, score, agreement: signal.agreement, caps, bindingCap,
    circuitReason: circuitCap === 1 ? (learning.drawdown >= .10 ? "drawdown" : "loss-streak") : null,
    marginGuard: { estimatedLiquidationDistancePct: (1 / leverage - .005) * 100, stopDistancePct: STOP_MOVE * 100, compatible: 1 / leverage - .005 > STOP_MOVE * 2 },
    reason: cold ? `Cold start bound at ${leverage}x` : `${bindingCap} cap bound leverage at ${leverage}x`
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

  const leverage = simulator.leverageLearning;
  leverage.closedTrades += 1;
  leverage.lastLeverage = trade.leverage;
  leverage.peakBank = Math.max(leverage.peakBank, simulator.bank);
  leverage.drawdown = leverage.peakBank > 0 ? clamp(1 - simulator.bank / leverage.peakBank, 0, 1) : 0;
  const risk = Math.max(trade.maeAsset * trade.leverage, .02);
  const riskAdjustedReward = clamp(trade.net / risk, -2, 2);
  const previousTarget = leverage.target;
  if (trade.net < 0) {
    leverage.lossStreak += 1;
    leverage.target = Math.max(1, previousTarget - (leverage.drawdown >= .10 || leverage.lossStreak >= 2 ? 2 : 1));
  } else {
    leverage.lossStreak = 0;
    if (leverage.drawdown >= .10) leverage.target = Math.max(1, previousTarget - 1);
    else if (riskAdjustedReward >= .5 && trade.mfeAsset >= trade.maeAsset) leverage.target = Math.min(10, previousTarget + 1);
  }
  trade.leverageLearning = {
    version: leverage.version,
    objective: leverage.objective,
    riskAdjustedReward,
    targetBefore: previousTarget,
    targetAfter: leverage.target,
    drawdownAfter: leverage.drawdown,
    lossStreakAfter: leverage.lossStreak
  };
}

function realizeSlice(simulator, position, exit, fraction, final) {
  const assetGross = returnFor(position, exit.price);
  const feeRate = FEE_RATE * position.leverage;
  const slippageRate = ESTIMATED_SLIPPAGE_RATE * position.leverage;
  const net = assetGross * position.leverage - feeRate - slippageRate;
  let pnl = position.capital * fraction * net;
  const fee = position.capital * fraction * feeRate;
  const estimatedSlippage = position.capital * fraction * slippageRate;
  const nextBank = simulator.bank + pnl;
  if (!finite(nextBank) || nextBank < 0) {
    position.insolvencyEvent = { time: exit.time, estimatedDeficit: finite(nextBank) ? -nextBank : null };
    pnl = -simulator.bank;
    simulator.bank = 0;
  } else simulator.bank = nextBank;
  position.realizedPnl += pnl;
  position.realizedAssetReturn += assetGross * fraction;
  position.feesPaid += fee;
  position.remainingFraction = Math.max(0, position.remainingFraction - fraction);
  position.estimatedSlippagePaid += estimatedSlippage;
  const slice = { fraction, price: exit.price, time: exit.time, reason: exit.reason, assetGross, leverage: position.leverage, estimatedFee: fee, estimatedSlippage, netRoi: net, pnlCurrency: pnl, pnl };
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
    assetReturn: position.realizedAssetReturn,
    weightedAssetReturn: position.realizedAssetReturn,
    net: totalNet,
    netRoi: totalNet,
    roi: totalNet,
    pnl: totalPnl,
    pnlCurrency: totalPnl,
    bankAfter: simulator.bank
  };
  simulator.trades.unshift(trade);
  simulator.trades = simulator.trades.slice(0, 200);
  simulator.position = null;
  learnFromTrade(simulator, trade);
}

function openPosition(simulator, side, signal, currentByTf, market) {
  const leverageDecision = selectLeverage(simulator, signal, market);
  const lossRateAtStop = leverageDecision.leverage * (STOP_MOVE + FEE_RATE + ESTIMATED_SLIPPAGE_RATE);
  const riskBudgetCurrency = simulator.bank * MAX_EQUITY_RISK;
  const capital = Math.min(simulator.bank, riskBudgetCurrency / lossRateAtStop);
  simulator.position = {
    side,
    entry: market.close,
    entryTime: market.closeTime,
    lastEvaluatedCloseTime: market.closeTime,
    capital,
    notional: capital * leverageDecision.leverage,
    riskBudgetCurrency,
    maxEquityRiskPct: MAX_EQUITY_RISK * 100,
    estimatedLossAtStop: capital * lossRateAtStop,
    remainingFraction: 1,
    partialTaken: false,
    partials: [],
    realizedPnl: 0,
    realizedAssetReturn: 0,
    feesPaid: 0,
    estimatedSlippagePaid: 0,
    maeAsset: 0,
    mfeAsset: 0,
    leverage: leverageDecision.leverage,
    leverageReason: leverageDecision.reason,
    leverageDecision,
    entryVolatility: leverageDecision.volatility,
    regime: leverageDecision.volatility >= .05 ? "high-volatility" : leverageDecision.volatility <= .015 ? "low-volatility" : "normal-volatility",
    longScore: signal.long,
    shortScore: signal.short,
    agreement: signal.agreement,
    parts: signal.parts,
    timeframeScores: Object.fromEntries(TIMEFRAMES.map(timeframe => [timeframe, { long: currentByTf[timeframe].long, short: currentByTf[timeframe].short }]))
  };
  simulator.lastEntryKey = `${market.closeTime}-${side}`;
}

export function processSimulator(simulator, currentByTf, rowsByTf) {
  if (!validInputs(currentByTf, rowsByTf)) return { changed: false, paused: true, invalidData: true };
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
      const liquidationDistance = 1 / position.leverage - .005;
      const liquidationPrice = position.side === "long" ? position.entry * (1 - liquidationDistance) : position.entry * (1 + liquidationDistance);
      const liquidationGap = position.side === "long" ? candle.open <= liquidationPrice : candle.open >= liquidationPrice;
      if (liquidationGap) {
        position.maeAsset = Math.max(position.maeAsset, liquidationDistance);
        position.excursionQuality = "bounded-at-liquidation-gap";
        position.liquidationEvent = { time: candle.closeTime, price: liquidationPrice, gapOpen: candle.open };
        exit = { price: liquidationPrice, time: candle.closeTime, reason: "Conservative liquidation gap" }; break;
      }
      const stopGap = position.side === "long" ? candle.open <= stopPrice : candle.open >= stopPrice;
      if (stopGap) {
        position.maeAsset = Math.max(position.maeAsset, Math.abs(candle.open / position.entry - 1));
        position.excursionQuality = "gap-filled-at-open";
        exit = { price: candle.open, time: candle.closeTime, reason: "Stop gap filled at open" }; break;
      }
      const stopHit = position.side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice;
      const targetHit = position.side === "long" ? candle.high >= targetPrice : candle.low <= targetPrice;
      if (stopHit) {
        position.maeAsset = Math.max(position.maeAsset, STOP_MOVE);
        position.excursionQuality = "bounded-at-conservative-stop";
        exit = { price: stopPrice, time: candle.closeTime, reason: "Stop 2.5% asset move" }; break;
      }
      if (targetHit) {
        position.mfeAsset = Math.max(position.mfeAsset, .05);
        position.excursionQuality = "bounded-at-target";
        exit = { price: targetPrice, time: candle.closeTime, reason: "Target 5% asset move" }; break;
      }
      const favorable = position.side === "long" ? candle.high / position.entry - 1 : 1 - candle.low / position.entry;
      const adverse = position.side === "long" ? 1 - candle.low / position.entry : candle.high / position.entry - 1;
      position.mfeAsset = Math.max(position.mfeAsset, favorable, 0);
      position.maeAsset = Math.max(position.maeAsset, adverse, 0);
    }
    if (exit) {
      realizeSlice(simulator, position, exit, position.remainingFraction, true);
      closedThisUpdate = true;
    } else if (completed.length) {
      const ownScore = signal[position.side];
      const profitable = returnFor(position, market.close) > FEE_RATE + ESTIMATED_SLIPPAGE_RATE;
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
  const assetReturn = returnFor(position, market.close);
  const net = assetReturn * position.leverage - (FEE_RATE + ESTIMATED_SLIPPAGE_RATE) * position.leverage;
  const pnl = position.capital * position.remainingFraction * net;
  return {
    equity: simulator.bank + pnl,
    pnl,
    pct: net * 100,
    assetReturn: assetReturn * 100,
    leverage: position.leverage,
    estimatedFee: position.capital * position.remainingFraction * FEE_RATE * position.leverage,
    estimatedSlippage: position.capital * position.remainingFraction * ESTIMATED_SLIPPAGE_RATE * position.leverage,
    realizedPnl: position.realizedPnl
  };
}

import { WEIGHTS } from "./strategy.js";
import { detectPatternCandidates, PATTERN_REGISTRY, RECENT_MEMORY, TOTAL_MEMORY } from "./institutional-intelligence.js";

export const EXECUTION_TIMEFRAME = "1m";
export const TIMEFRAMES = ["1m", "5m", "15m", "1h"];
export { RECENT_MEMORY, TOTAL_MEMORY };
export const SIMULATOR_VERSION = 5;
export const STRATEGY_VERSION = "institutional-1m-two-horizon-memory-v2";

export const TF_INFLUENCE = { "1m": .40, "5m": .25, "15m": .20, "1h": .15 };
const FEE_RATE = .002;
const ESTIMATED_SLIPPAGE_RATE = .001;
const STOP_MOVE = .025;
const MAX_EQUITY_RISK = .02;
const PARTIAL_FRACTION = .5;
const STRUCTURAL_PARTIAL_FRACTION = .25;
const MIN_NEW_LEVERAGE = 10;
const MAX_NEW_LEVERAGE = 20;
const ONE_MINUTE = 60 * 1000;
const MACRO_MAX_AGE = 30 * 60 * 1000;
const CONTEXT_MAX_AGE = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 };
const INITIAL_BANK = 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(value);
const INDICATOR_KEYS = Object.freeze(Object.keys(WEIGHTS));
const PATTERN_IDS = new Set(PATTERN_REGISTRY.map(pattern => pattern.id));
const WEIGHT_TOLERANCE = 1e-8;
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
  }) && Array.isArray(rowsByTf[EXECUTION_TIMEFRAME]) && rowsByTf[EXECUTION_TIMEFRAME].length > 0
    && rowsByTf[EXECUTION_TIMEFRAME].every(isValidCandle)
    && rowsByTf[EXECUTION_TIMEFRAME].at(-1).closeTime === currentByTf[EXECUTION_TIMEFRAME].closeTime;
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
    target: MIN_NEW_LEVERAGE,
    lastLeverage: MIN_NEW_LEVERAGE,
    lossStreak: 0,
    peakBank: 1000,
    drawdown: 0
  };
}

export function createSimulator(now = Date.now()) {
  return {
    version: SIMULATOR_VERSION,
    initialBank: INITIAL_BANK,
    bank: INITIAL_BANK,
    position: null,
    pendingReversal: null,
    trades: [],
    weights: { ...WEIGHTS },
    learningSteps: 0,
    learning: learningMetadata(),
    leverageLearning: leverageMetadata(),
    lastEntryKey: null,
    lastProcessedCloseTime: null,
    decisionSnapshots: [],
    riskControl: { halted: false, reason: null, haltedAt: null, threshold: 800 },
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

function canonicalParts(parts) {
  if (!parts || typeof parts !== "object" || Array.isArray(parts) || Object.keys(parts).length !== INDICATOR_KEYS.length) return null;
  if (!INDICATOR_KEYS.every(key => finite(parts[key]) && parts[key] >= -1 && parts[key] <= 1)) return null;
  return Object.fromEntries(INDICATOR_KEYS.map(key => [key, parts[key]]));
}

function canonicalCandidates(ids) {
  if (!Array.isArray(ids) || ids.length > PATTERN_REGISTRY.length || new Set(ids).size !== ids.length || !ids.every(id => PATTERN_IDS.has(id))) return null;
  return [...ids];
}

function canonicalWeights(weights) {
  if (!weights || typeof weights !== "object" || Object.keys(weights).length !== INDICATOR_KEYS.length) return null;
  if (!INDICATOR_KEYS.every(key => finite(weights[key]) && weights[key] > 0 && weights[key] <= 100)) return null;
  return Object.fromEntries(INDICATOR_KEYS.map(key => [key, weights[key]]));
}

function sameWeights(left, right) {
  return left && right && INDICATOR_KEYS.every(key => Math.abs(left[key] - right[key]) <= WEIGHT_TOLERANCE);
}

function horizonSignal(trades, key, decay) {
  let sum = 0, total = 0;
  trades.forEach((trade, index) => {
    if (!finite(trade?.net) || !finite(trade?.parts?.[key])) return;
    const reward = clamp(trade.net / .05, -1, 1);
    const asymmetric = reward < 0 ? reward * 1.35 : reward * .75;
    const direction = trade.side === "long" ? 1 : -1;
    const weight = decay && trades.length > 1 ? 1 - .5 * index / (trades.length - 1) : 1;
    sum += asymmetric * clamp(trade.parts[key] * direction, -1, 1) * weight;
    total += weight;
  });
  return total ? sum / total : null;
}

export function weightsFromTradeMemory(trades = []) {
  const bounded = Array.isArray(trades) ? trades.slice(0, TOTAL_MEMORY) : [];
  const recent = bounded.slice(0, RECENT_MEMORY);
  const archive = bounded.slice(RECENT_MEMORY);
  const adjusted = {};
  for (const key of Object.keys(WEIGHTS)) {
    const priority = horizonSignal(recent, key, true);
    const baseline = horizonSignal(archive, key, false);
    let signal = priority === null ? baseline || 0 : baseline === null ? priority : .75 * priority + .25 * baseline;
    // Archive is regularization/regression context, never a veto over a
    // negative priority regime.
    if (priority !== null && priority < 0) signal = Math.min(signal, priority * .5);
    adjusted[key] = WEIGHTS[key] * (1 + .12 * clamp(signal, -1, 1));
  }
  return projectWeights(normalizeWeights(adjusted));
}

export function migrateSimulator(raw, now = Date.now()) {
  const fresh = createSimulator(now);
  if (!raw || typeof raw !== "object" || !finite(raw.bank) || raw.bank < 0 || !validWeights(raw.weights)) return fresh;
  let weights = { ...WEIGHTS };
  const trades = Array.isArray(raw.trades) ? raw.trades.map((trade, persistedIndex) => ({ trade, persistedIndex }))
    .filter(({trade}) => trade && finite(trade.net) && finite(trade.pnl) && finite(trade.exitTime) && trade.exitTime > 0
      && ["long", "short"].includes(trade.side) && finite(trade.entry) && trade.entry > 0)
    .sort((a, b) => b.trade.exitTime - a.trade.exitTime || a.persistedIndex - b.persistedIndex)
    .map(({trade}) => {
      const { learning: _forgedLearning, leverageLearning: _forgedLeverageLearning,
        decisionSnapshot: _advisoryDecisionSnapshot, parts: _advisoryParts,
        candidateIds: _advisoryCandidateIds, ...primitive } = trade;
      return ({
      ...primitive,
      // Persisted attribution is advisory and cannot be recomputed without
      // the original closed candles. Keep the outcome, discard causal claims.
      parts: {},
      candidateIds: [],
      evidenceAvailability: "unavailable-after-migration",
      leverage: boundedInteger(trade.leverage, 1, 1, MAX_NEW_LEVERAGE),
      netRoi: trade.net,
      pnlCurrency: trade.pnl,
      weightedAssetReturn: finite(trade.weightedAssetReturn) ? trade.weightedAssetReturn : finite(trade.assetReturn) ? trade.assetReturn : finite(trade.gross) ? trade.gross : null,
      legacyMetricsAuditable: finite(trade.weightedAssetReturn) || finite(trade.assetReturn)
    }); }).slice(0, TOTAL_MEMORY) : [];
  const validationContext = [];
  const accepted = [];
  for (const trade of trades.slice().reverse()) {
    const evidence = trade.causalEvidence;
    const parts = evidence?.version === 1 ? canonicalParts(evidence.parts) : null;
    const candidateIds = evidence?.version === 1 ? canonicalCandidates(evidence.candidateIds) : null;
    const before = evidence?.version === 1 ? canonicalWeights(evidence.weightsBefore) : null;
    const expectedAfter = evidence?.version === 1 ? canonicalWeights(evidence.expectedWeightsAfter) : null;
    if (!parts || !candidateIds || !before || !expectedAfter) continue;
    const contextual = { ...trade, parts, candidateIds };
    const recomputedBefore = weightsFromTradeMemory(validationContext.slice().reverse());
    const recomputedAfter = weightsFromTradeMemory([contextual, ...validationContext.slice().reverse()]);
    // A malformed expected transition rejects this record, but schema-valid
    // causal inputs stay in validation context so one damaged snapshot does
    // not invalidate every later independently matching record.
    validationContext.push(contextual);
    if (!sameWeights(before, recomputedBefore) || !sameWeights(expectedAfter, recomputedAfter)) continue;
    trade.parts = parts; trade.candidateIds = candidateIds;
    trade.evidenceAvailability = "consistent-causal-evidence-v1";
    trade.learning = { reward: clamp(trade.net / .05, -1, 1), eta: null,
      weightsAfter: expectedAfter, metadataVersion: 1, reconstructed: true };
    accepted.push(trade);
  }
  weights = weightsFromTradeMemory(trades);
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
    const rawPlans = Array.isArray(raw.position.structuralPartials) ? raw.position.structuralPartials : [];
    const migratedPlans = rawPlans.length <= 2 ? rawPlans.map((plan, index) => {
      const ahead = finite(plan?.level) && plan.level > 0 && (raw.position.side === "long" ? plan.level > raw.position.entry : plan.level < raw.position.entry);
      const allowedReasons = { ema: ["EMA 50", "EMA 200"], support: ["Confirmed swing support"], resistance: ["Confirmed swing resistance"] };
      const typeValid = Array.isArray(allowedReasons[plan?.type]) && allowedReasons[plan.type].includes(plan.reason);
      if (!ahead || !typeValid || (index && Math.abs(plan.level - rawPlans[index - 1]?.level) < 1e-9)) return null;
      const execution = migratedPartials.find(part => part.reason === `Structural partial: ${plan.reason}` && Math.abs(part.price - plan.level) < 1e-9);
      return { level: plan.level, reason: plan.reason, type: plan.type, order: index + 1, fraction: STRUCTURAL_PARTIAL_FRACTION,
        executed: Boolean(execution), ...(execution ? { executedAt: execution.time, executionPrice: execution.price } : {}) };
    }) : [];
    const plansValid = migratedPlans.every(Boolean);
    if (positionValid && plansValid) position = {
      side: raw.position.side,
      entry: raw.position.entry,
      entryTime: raw.position.entryTime,
      lastEvaluatedCloseTime: finite(raw.position.lastEvaluatedCloseTime) ? Math.max(raw.position.entryTime, raw.position.lastEvaluatedCloseTime) : raw.position.entryTime,
      capital: originalCapital,
      legacyRiskPolicy: "grandfathered-existing-exposure-no-resize",
      remainingFraction: hasAuditablePartial ? raw.position.remainingFraction : 1,
      partialTaken: hasAuditablePartial,
      neutralPartialTaken: migratedPartials.some(part => part.reason === "Partial profit at neutral approach"),
      structuralPartials: migratedPlans,
      realizedPnl: hasAuditablePartial ? migratedPartials.reduce((sum, part) => sum + part.pnlCurrency, 0) : 0,
      partials: hasAuditablePartial ? migratedPartials : [],
      dataGap: raw.position.dataGap === true,
      leverage: legacyLeverage,
      leverageReason: `Migrated position preserved at validated ${legacyLeverage}x; future entries use the 10x-20x policy`,
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
      leverageDecision: null,
      regime: typeof raw.position.regime === "string" ? raw.position.regime : "unknown"
    };
  }
  const steps = Number.isInteger(raw.learningSteps) && raw.learningSteps >= 0 ? raw.learningSteps : 0;
  const leverageLearning = trades.slice().reverse().reduce((state, trade) => {
    state.closedTrades += 1; state.lastLeverage = boundedInteger(trade.leverage, MIN_NEW_LEVERAGE, 1, MAX_NEW_LEVERAGE);
    const capital = finite(trade.capital) && trade.capital > 0 ? trade.capital : null;
    const costRoi = capital ? ((finite(trade.feesPaid)?trade.feesPaid:0)+(finite(trade.estimatedSlippagePaid)?trade.estimatedSlippagePaid:0))/capital : null;
    const derivedNet = finite(trade.weightedAssetReturn) && finite(trade.leverage) && finite(costRoi) ? trade.weightedAssetReturn*trade.leverage-costRoi : trade.net;
    state.lossStreak = derivedNet < 0 ? state.lossStreak + 1 : 0;
    if (derivedNet < 0) state.target = Math.max(MIN_NEW_LEVERAGE, state.target - 1);
    else if (finite(derivedNet) && derivedNet >= .025) state.target = Math.min(MAX_NEW_LEVERAGE, state.target + 1);
    if (finite(trade.bankAfter)) state.peakBank = Math.max(state.peakBank, trade.bankAfter);
    return state;
  }, { ...leverageMetadata() });
  if (trades.length) {
    const recent = trades.slice(0, RECENT_MEMORY).filter(t => finite(t.net));
    const archive = trades.slice(RECENT_MEMORY).filter(t => finite(t.net));
    const weightedMean = rows => {
      let sum=0,total=0;
      rows.forEach((trade,index) => { const weight=rows===recent&&rows.length>1?1-.5*index/(rows.length-1):1; sum+=trade.net*weight; total+=weight; });
      return total ? sum/total : null;
    };
    const priority=weightedMean(recent), baseline=weightedMean(archive);
    let blend=priority===null?(baseline||0):baseline===null?priority:.75*priority+.25*baseline;
    if(priority<0) blend=Math.min(blend,priority*.5);
    leverageLearning.target=clamp(MIN_NEW_LEVERAGE+Math.round(clamp(blend/.025,-1,1)*5),MIN_NEW_LEVERAGE,15);
    leverageLearning.lossStreak=recent.findIndex(t=>t.net>=0);
    if(leverageLearning.lossStreak<0) leverageLearning.lossStreak=recent.length;
  }
  leverageLearning.peakBank = Math.max(leverageLearning.peakBank, raw.bank, INITIAL_BANK);
  leverageLearning.drawdown = clamp(1 - raw.bank / leverageLearning.peakBank, 0, 1);
  return {
    ...fresh,
    initialBank: INITIAL_BANK,
    bank: raw.bank,
    position,
    pendingReversal: raw.pendingReversal && ["long", "short"].includes(raw.pendingReversal.side) && finite(raw.pendingReversal.requestedAt)
      ? { side: raw.pendingReversal.side, requestedAt: raw.pendingReversal.requestedAt,
          expectedNextCloseTime: raw.pendingReversal.requestedAt + ONE_MINUTE,
          score: finite(raw.pendingReversal.score) ? raw.pendingReversal.score : null,
          agreement: boundedInteger(raw.pendingReversal.agreement, 0, 0, 4) } : null,
    trades,
    weights,
    learningSteps: steps,
    learning: { ...learningMetadata(steps), migratedFromVersion: finite(raw.learning?.version) ? raw.learning.version : null },
    leverageLearning,
    lastEntryKey: typeof raw.lastEntryKey === "string" ? raw.lastEntryKey : null,
    lastProcessedCloseTime: finite(raw.lastProcessedCloseTime) ? raw.lastProcessedCloseTime : null,
    decisionSnapshots: Array.isArray(raw.decisionSnapshots) ? raw.decisionSnapshots.filter(s => s && finite(s.decisionTime)).slice(0, 200) : [],
    riskControl: raw.riskControl?.halted === true || raw.bank <= INITIAL_BANK * .8
      ? { halted: true, reason: "20% capital protection threshold reconstructed", haltedAt: finite(raw.riskControl?.haltedAt) ? raw.riskControl.haltedAt : now,
          threshold: INITIAL_BANK * .8 }
      : { halted: false, reason: null, haltedAt: null, threshold: INITIAL_BANK * .8 },
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
  const confidenceCap = score >= 95 && signal.agreement === 4 ? 20 : score >= 90 && signal.agreement === 4 ? 17 : score >= 84 ? 14 : 12;
  const volatilityCap = clamp(Math.floor(.20 / volatility) + 10, MIN_NEW_LEVERAGE, MAX_NEW_LEVERAGE);
  const circuitCap = learning.lossStreak >= 2 || learning.drawdown >= .10 ? MIN_NEW_LEVERAGE : MAX_NEW_LEVERAGE;
  const coldCap = score >= 90 && signal.agreement === 4 && volatility <= .02 ? 12 : MIN_NEW_LEVERAGE;
  const caps = { learned: cold ? coldCap : clamp(learning.target, MIN_NEW_LEVERAGE, MAX_NEW_LEVERAGE), confidence: confidenceCap, volatility: volatilityCap, circuit: circuitCap, hard: MAX_NEW_LEVERAGE };
  const leverage = clamp(Math.min(...Object.values(caps)), MIN_NEW_LEVERAGE, MAX_NEW_LEVERAGE);
  const bindingCap = Object.entries(caps).find(([, value]) => value === leverage)?.[0] || "hard";
  return {
    leverage, volatility, score, agreement: signal.agreement, caps, bindingCap,
    circuitReason: circuitCap === MIN_NEW_LEVERAGE ? (learning.drawdown >= .10 ? "drawdown" : "loss-streak") : null,
    marginGuard: { estimatedLiquidationDistancePct: (1 / leverage - .005) * 100, stopDistancePct: STOP_MOVE * 100, compatible: 1 / leverage - .005 > STOP_MOVE * 2 },
    reason: cold ? `Cold start bound at ${leverage}x` : `${bindingCap} cap bound leverage at ${leverage}x`
  };
}

export function planStructuralPartials(side, market, candles) {
  if (!["long", "short"].includes(side) || !finite(market?.close) || !finite(market?.closeTime)) return [];
  const entry = market.close;
  const history = (Array.isArray(candles) ? candles : []).filter(c => isValidCandle(c) && c.closeTime <= market.closeTime);
  const noise = Math.max(entry * (FEE_RATE + ESTIMATED_SLIPPAGE_RATE), entry * volatilityProxy(market) * .20, entry * .002);
  const reach = entry * .05;
  const candidates = [];
  for (const [reason, level] of [["EMA 50", market.ema50], ["EMA 200", market.ema200]]) {
    if (finite(level)) candidates.push({ level, reason, type: "ema" });
  }
  for (let i = 2; i < history.length - 2; i += 1) {
    const window = history.slice(i - 2, i + 3);
    if (side === "long" && history[i].high === Math.max(...window.map(c => c.high))) candidates.push({ level: history[i].high, reason: "Confirmed swing resistance", type: "resistance" });
    if (side === "short" && history[i].low === Math.min(...window.map(c => c.low))) candidates.push({ level: history[i].low, reason: "Confirmed swing support", type: "support" });
  }
  const valid = candidates.filter(c => finite(c.level) && (side === "long" ? c.level > entry + noise && c.level <= entry + reach : c.level < entry - noise && c.level >= entry - reach))
    .sort((a, b) => side === "long" ? a.level - b.level : b.level - a.level);
  const unique = [];
  for (const candidate of valid) if (!unique.some(item => Math.abs(item.level - candidate.level) < noise)) unique.push(candidate);
  return unique.slice(0, 2).map((candidate, index) => ({ ...candidate, order: index + 1, fraction: STRUCTURAL_PARTIAL_FRACTION, executed: false }));
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
  const weightsBefore = { ...simulator.weights };
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
  // The persisted result is recomputed from one occurrence of every validated
  // trade: 75% priority-window aggregate and 25% archive baseline.
  simulator.weights = weightsFromTradeMemory(simulator.trades);
  simulator.learningSteps += 1;
  simulator.learning.steps = simulator.learningSteps;
  trade.learning = { reward, eta, weightsAfter: { ...simulator.weights }, metadataVersion: simulator.learning.version };
  const evidenceParts = canonicalParts(trade.parts);
  const evidenceCandidates = canonicalCandidates(trade.candidateIds);
  if (evidenceParts && evidenceCandidates) trade.causalEvidence = {
    version: 1,
    parts: evidenceParts,
    candidateIds: evidenceCandidates,
    weightsBefore,
    expectedWeightsAfter: { ...simulator.weights }
  };

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
    leverage.target = Math.max(MIN_NEW_LEVERAGE, previousTarget - (leverage.drawdown >= .10 || leverage.lossStreak >= 2 ? 2 : 1));
  } else {
    leverage.lossStreak = 0;
    if (leverage.drawdown >= .10) leverage.target = Math.max(MIN_NEW_LEVERAGE, previousTarget - 1);
    else if (riskAdjustedReward >= .5 && trade.mfeAsset >= trade.maeAsset) leverage.target = Math.min(MAX_NEW_LEVERAGE, previousTarget + 1);
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
  simulator.trades = simulator.trades.slice(0, TOTAL_MEMORY);
  simulator.position = null;
  learnFromTrade(simulator, trade);
}

function openPosition(simulator, side, signal, currentByTf, market, executionRows, decision) {
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
    neutralPartialTaken: false,
    partials: [],
    structuralPartials: planStructuralPartials(side, market, executionRows),
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
    timeframeScores: Object.fromEntries(TIMEFRAMES.map(timeframe => [timeframe, { long: currentByTf[timeframe].long, short: currentByTf[timeframe].short }])),
    decisionSnapshot: decision
    ,candidateIds: decision?.candidateIds || []
  };
  simulator.lastEntryKey = `${market.closeTime}-${side}`;
}

function macroEligibility(snapshot, decisionTime) {
  const availableFrom = finite(snapshot?.availableFrom) ? snapshot.availableFrom : snapshot?.updatedAt;
  const valid = snapshot && finite(snapshot.score) && finite(availableFrom) && availableFrom <= decisionTime
    && decisionTime - availableFrom <= MACRO_MAX_AGE && snapshot.stale !== true;
  return { eligible: Boolean(valid && snapshot.score >= 80), score: valid ? snapshot.score : null,
    source: valid && typeof snapshot.source === "string" ? snapshot.source : null, updatedAt: valid ? availableFrom : null, availableFrom: finite(availableFrom) ? availableFrom : null,
    status: !snapshot ? "missing" : !valid ? "stale-or-future" : snapshot.score >= 80 ? "intensity-eligible" : "below-threshold" };
}

export function processSimulator(simulator, currentByTf, rowsByTf, options = {}) {
  if (!validInputs(currentByTf, rowsByTf)) return { changed: false, paused: true, invalidData: true };
  const signal = getConsensus(currentByTf);
  const market = currentByTf[EXECUTION_TIMEFRAME];
  if (TIMEFRAMES.some(tf => currentByTf[tf].closeTime > market.closeTime || market.closeTime - currentByTf[tf].closeTime > CONTEXT_MAX_AGE[tf])) {
    return { changed: false, paused: true, invalidData: true, contextMisaligned: true };
  }
  const evaluationNow = finite(options.now) ? options.now : Date.now();
  if (market.closeTime >= evaluationNow || simulator.lastProcessedCloseTime === market.closeTime) return { changed: false, paused: true, duplicateOrOpen: true };
  simulator.lastProcessedCloseTime = market.closeTime;
  simulator.riskControl = simulator.riskControl && typeof simulator.riskControl === "object" ? simulator.riskControl : {};
  simulator.initialBank = INITIAL_BANK;
  simulator.riskControl.threshold = INITIAL_BANK * .8;
  const macro = macroEligibility(options.macroSnapshot, market.closeTime);
  const decision = { decisionTime: market.closeTime, score: signal[signal.side], side: signal.side, agreement: signal.agreement,
    candidateIds: detectPatternCandidates(market),
    timeframeScores: Object.fromEntries(TIMEFRAMES.map(tf => [tf, { long: currentByTf[tf].long, short: currentByTf[tf].short }])),
    macro, policy: "macro-intensity-eligibility-not-direction" };
  simulator.decisionSnapshots.unshift(decision); simulator.decisionSnapshots = simulator.decisionSnapshots.slice(0, 200);
  const mark = getMarkToMarket(simulator, market);
  if (!simulator.riskControl.halted && mark.equity <= simulator.riskControl.threshold) {
    if (simulator.position) realizeSlice(simulator, simulator.position, { price: market.close, time: market.closeTime, reason: "Capital protection threshold" }, simulator.position.remainingFraction, true);
    simulator.pendingReversal = null;
    simulator.riskControl = { halted: true, reason: "20% capital protection threshold", haltedAt: market.closeTime, threshold: INITIAL_BANK * .8 };
    return { changed: true, paused: true, riskHalt: true };
  }
  if (simulator.riskControl.halted) { simulator.pendingReversal = null; return { changed: true, paused: true, riskHalt: true }; }
  let closedThisUpdate = false;
  if (simulator.position) {
    const position = simulator.position;
    const checkpoint = position.lastEvaluatedCloseTime ?? position.entryTime;
    const completed = rowsByTf[EXECUTION_TIMEFRAME].filter(candle => candle.closeTime > checkpoint && candle.closeTime <= market.closeTime);
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
      for (const plan of position.structuralPartials || []) {
        const hit = !plan.executed && (position.side === "long" ? candle.high >= plan.level : candle.low <= plan.level);
        if (!hit) continue;
        const fraction = Math.min(plan.fraction || STRUCTURAL_PARTIAL_FRACTION, Math.max(0, position.remainingFraction - .25));
        if (fraction <= 0) break;
        realizeSlice(simulator, position, { price: plan.level, time: candle.closeTime, reason: `Structural partial: ${plan.reason}` }, fraction, false);
        plan.executed = true;
        plan.executedAt = candle.closeTime;
        plan.executionPrice = plan.level;
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
        if (!position.neutralPartialTaken && ownScore <= 62 && profitable) {
          const fraction = Math.min(PARTIAL_FRACTION, Math.max(0, position.remainingFraction - .25));
          if (fraction > 0) realizeSlice(simulator, position, { price: market.close, time: market.closeTime, reason: "Partial profit at neutral approach" }, fraction, false);
          position.neutralPartialTaken = true;
        }
        position.lastEvaluatedCloseTime = completed.at(-1).closeTime;
      }
    }
    if (closedThisUpdate) {
      if (simulator.bank <= INITIAL_BANK * .8) {
        simulator.pendingReversal = null;
        simulator.riskControl = { halted:true, reason:"20% capital protection threshold", haltedAt:market.closeTime, threshold:INITIAL_BANK*.8 };
      }
      const opposite = oppositeSignal(position, signal, currentByTf);
      if (!simulator.riskControl.halted && opposite.score >= 75 && opposite.agreement >= 3) {
        simulator.pendingReversal = {
          side: opposite.side,
          requestedAt: market.closeTime,
          expectedNextCloseTime: market.closeTime + ONE_MINUTE,
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
      const expected = pending.expectedNextCloseTime ?? pending.requestedAt + ONE_MINUTE;
      const hasExpectedClosedCandle = rowsByTf[EXECUTION_TIMEFRAME].some(candle => candle.closeTime === expected);
      if (market.closeTime === expected && hasExpectedClosedCandle && stillExtreme) {
        openPosition(simulator, pending.side, signal, currentByTf, market, rowsByTf[EXECUTION_TIMEFRAME], decision);
        simulator.pendingReversal = null;
      } else if (market.closeTime >= expected && (!hasExpectedClosedCandle || market.closeTime > expected || !stillExtreme)) {
        simulator.pendingReversal = null;
      }
    } else if (!closedThisUpdate) {
      const score = Math.max(signal.long, signal.short);
      const extreme = (score >= 75 || (score >= 68 && score <= 74 && signal.agreement >= 3 && macro.eligible)) && signal.agreement >= 3;
      const entryKey = `${market.closeTime}-${signal.side}`;
      if (extreme && simulator.lastEntryKey !== entryKey) openPosition(simulator, signal.side, signal, currentByTf, market, rowsByTf[EXECUTION_TIMEFRAME], decision);
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

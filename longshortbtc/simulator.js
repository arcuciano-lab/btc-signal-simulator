import { WEIGHTS } from "./strategy.js";

export const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const TF_INFLUENCE = { "5m": .15, "15m": .20, "1h": .30, "4h": .35 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createSimulator(now = Date.now()) {
  return {
    initialBank: 1000,
    bank: 1000,
    position: null,
    trades: [],
    weights: { ...WEIGHTS },
    learningSteps: 0,
    lastEntryKey: null,
    startedAt: now
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

function learnFromTrade(simulator, trade) {
  const outcome = trade.net > 0 ? 1 : -1;
  const direction = trade.side === "long" ? 1 : -1;
  const adjusted = {};
  for (const key of Object.keys(WEIGHTS)) {
    const alignment = clamp(trade.parts[key] * direction, -1, 1);
    adjusted[key] = clamp(simulator.weights[key] * (1 + .04 * outcome * alignment), WEIGHTS[key] * .60, WEIGHTS[key] * 1.40);
  }
  const total = Object.values(adjusted).reduce((sum, value) => sum + value, 0);
  for (const key of Object.keys(adjusted)) simulator.weights[key] = adjusted[key] / total * 100;
  simulator.learningSteps += 1;
}

function closeTrade(simulator, exit) {
  const position = simulator.position;
  const gross = position.side === "long" ? exit.price / position.entry - 1 : position.entry / exit.price - 1;
  const net = gross - .002;
  const pnl = simulator.bank * net;
  simulator.bank = Math.max(0, simulator.bank + pnl);
  const trade = { ...position, exit:exit.price, exitTime:exit.time, reason:exit.reason, gross, net, pnl, bankAfter:simulator.bank };
  simulator.trades.unshift(trade);
  simulator.trades = simulator.trades.slice(0, 200);
  simulator.position = null;
  learnFromTrade(simulator, trade);
}

export function processSimulator(simulator, currentByTf, rowsByTf) {
  const signal = getConsensus(currentByTf);
  const market = currentByTf["5m"];
  if (simulator.position) {
    const position = simulator.position;
    const checkpoint = position.lastEvaluatedCloseTime ?? position.entryTime;
    const completed = rowsByTf["5m"].filter(candle => candle.closeTime > checkpoint);
    if (completed.length && completed[0].time > checkpoint + 1) {
      position.dataGap = true;
      return { changed:true, paused:true };
    }
    position.dataGap = false;
    let exit = null;
    for (const candle of completed) {
      const stopPrice = position.side === "long" ? position.entry * .975 : position.entry * 1.025;
      const targetPrice = position.side === "long" ? position.entry * 1.05 : position.entry * .95;
      const stopHit = position.side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice;
      const targetHit = position.side === "long" ? candle.high >= targetPrice : candle.low <= targetPrice;
      if (stopHit) { exit = { price:stopPrice, time:candle.closeTime, reason:"Stop 2,5%" }; break; }
      if (targetHit) { exit = { price:targetPrice, time:candle.closeTime, reason:"Objetivo 5%" }; break; }
    }
    const opposite = position.side === "long" ? signal.short : signal.long;
    const oppositeAgreement = TIMEFRAMES.filter(timeframe => currentByTf[timeframe][position.side === "long" ? "short" : "long"] >= 60).length;
    if (!exit && opposite >= 62 && oppositeAgreement >= 3) exit = { price:market.close, time:market.closeTime, reason:"Señal contraria" };
    if (exit) closeTrade(simulator, exit);
    else if (completed.length) position.lastEvaluatedCloseTime = completed.at(-1).closeTime;
  }
  if (!simulator.position) {
    const extreme = Math.max(signal.long, signal.short) >= 75 && signal.agreement >= 3;
    const entryKey = `${market.closeTime}-${signal.side}`;
    if (extreme && simulator.lastEntryKey !== entryKey) {
      simulator.position = {
        side:signal.side, entry:market.close, entryTime:market.closeTime, lastEvaluatedCloseTime:market.closeTime,
        longScore:signal.long, shortScore:signal.short, agreement:signal.agreement, parts:signal.parts,
        timeframeScores:Object.fromEntries(TIMEFRAMES.map(timeframe => [timeframe, { long:currentByTf[timeframe].long, short:currentByTf[timeframe].short }]))
      };
      simulator.lastEntryKey = entryKey;
    }
  }
  return { changed:true, paused:false };
}

export function getMarkToMarket(simulator, market) {
  if (!simulator.position || !market) return { equity:simulator.bank, pnl:0, pct:0 };
  const gross = simulator.position.side === "long" ? market.close / simulator.position.entry - 1 : simulator.position.entry / market.close - 1;
  const net = gross - .002;
  return { equity:simulator.bank * (1 + net), pnl:simulator.bank * net, pct:net * 100 };
}

const finite = Number.isFinite;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const FORBIDDEN = /\b(compra|vende|venta|comprar|vender|entra|entrada|salir|salida|buy|sell|enter|entry|exit)\b/iu;
export const TOTAL_MEMORY = 1000;
export const RECENT_MEMORY = 100;

function horizonMean(trades, valueOf, decay = false) {
  let weighted = 0, total = 0;
  trades.forEach((trade, index) => {
    const value = valueOf(trade);
    if (!finite(value)) return;
    // Newest is 1.0 and the edge of the priority window is 0.5: meaningful
    // recency without allowing one observation to dominate the sample.
    const weight = decay && trades.length > 1 ? 1 - .5 * index / (trades.length - 1) : 1;
    weighted += value * weight; total += weight;
  });
  return total ? weighted / total : null;
}

export function summarizeTradeMemory(input = []) {
  const trades = Array.isArray(input) ? input.slice(0, TOTAL_MEMORY) : [];
  const recent = trades.slice(0, RECENT_MEMORY);
  const archive = trades.slice(RECENT_MEMORY, TOTAL_MEMORY);
  const net = trade => finite(trade?.net) ? (trade.net < 0 ? 1.35 : .75) * clamp(trade.net / .05, -1, 1) : null;
  const recentMean = horizonMean(recent, net, true);
  const archiveMean = horizonMean(archive, net, false);
  let blendedMean = recentMean === null ? archiveMean : archiveMean === null ? recentMean : .75 * recentMean + .25 * archiveMean;
  if (recentMean !== null && recentMean < 0) blendedMean = Math.min(blendedMean, recentMean * .5);
  const wins = rows => rows.filter(t => finite(t?.net) && t.net > 0).length;
  return { stored: trades.length, recentCount: recent.length, archiveCount: archive.length, recentMean, archiveMean, blendedMean,
    recentWins: wins(recent), archiveWins: wins(archive), drift: recentMean !== null && archiveMean !== null ? recentMean - archiveMean : null };
}

export function resolveIndicatorVote(parts = {}, weights = {}) {
  let vote = 0;
  for (const [key, value] of Object.entries(parts)) if (finite(value) && finite(weights[key])) vote += value * weights[key];
  return Math.abs(vote) < 1e-9 ? "abstention" : vote > 0 ? "positive" : "negative";
}

export function validatePattern(candidate = {}, recentTrades = []) {
  const occurrences = Math.max(0, Math.trunc(candidate.occurrences || 0));
  const outcomes = Math.max(0, Math.trunc(candidate.outcomes || 0));
  const expectancy = finite(candidate.netExpectancyAfterCosts) ? candidate.netExpectancyAfterCosts : null;
  const successRate = finite(candidate.successRate) ? candidate.successRate : null;
  const recent = recentTrades.slice(0, RECENT_MEMORY).filter(t => finite(t.net) && Array.isArray(t.candidateIds) && t.candidateIds.includes(candidate.id));
  const compatible = recent.length > 0 && recent.reduce((sum, t) => sum + t.net, 0) > 0;
  const validated = occurrences >= 30 && outcomes >= 20 && expectancy > 0 && successRate >= .55 && compatible && candidate.noLookahead === true;
  return { name: String(candidate.name || "code-owned candidate"), occurrences, outcomes, expectancy, successRate,
    status: validated ? "validated" : "insufficient evidence", compatible, noLookahead: candidate.noLookahead === true };
}

export const PATTERN_REGISTRY = Object.freeze([
  { id:"ema-alignment", detect:m => finite(m?.ema50) && finite(m?.ema200) && finite(m?.close) && ((m.ema50>m.ema200&&m.close>m.ema50)||(m.ema50<m.ema200&&m.close<m.ema50)) },
  { id:"momentum-expansion", detect:m => finite(m?.hist) && finite(m?.volRatio) && Math.abs(m.hist)>0 && m.volRatio>=1.1 },
  { id:"band-extension", detect:m => finite(m?.bbUpper) && finite(m?.bbLower) && finite(m?.close) && (m.close>=m.bbUpper||m.close<=m.bbLower) }
]);

export function detectPatternCandidates(market) {
  return PATTERN_REGISTRY.filter(candidate => candidate.detect(market)).map(candidate => candidate.id);
}

export function buildPatternEvidence(rows, horizon = 5, modeledCost = .003) {
  const closed = Array.isArray(rows) ? rows.filter(row => finite(row?.close) && finite(row?.closeTime)) : [];
  return PATTERN_REGISTRY.map(candidate => {
    let occurrences=0, outcomes=0, total=0, successes=0;
    for (let i=0;i<closed.length;i+=1) {
      if (!candidate.detect(closed[i])) continue;
      occurrences+=1;
      const future=closed[i+horizon]; if (!future) continue;
      const direction=finite(closed[i].long)&&finite(closed[i].short)&&closed[i].short>closed[i].long?-1:1;
      const net=(future.close/closed[i].close-1)*direction-modeledCost;
      outcomes+=1; total+=net; if(net>0) successes+=1;
    }
    return { id:candidate.id,name:candidate.id,noLookahead:true,occurrences,outcomes,netExpectancyAfterCosts:outcomes?total/outcomes:null,successRate:outcomes?successes/outcomes:null };
  });
}

function bar(value, width = 12) {
  const filled = Math.round(clamp(finite(value) ? value : 0, 0, 100) / 100 * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function buildInstitutionalReport({ market, simulator, macroSnapshot, patterns = [] } = {}) {
  const allTrades = Array.isArray(simulator?.trades) ? simulator.trades.slice(0, TOTAL_MEMORY) : [];
  const trades = allTrades.slice(0, RECENT_MEMORY);
  const memory = summarizeTradeMemory(allTrades);
  const weights = simulator?.weights || {};
  const weightRows = Object.entries(weights).map(([key, value]) => `${key.toUpperCase().padEnd(9)} ${bar(value)} ${Math.round(value)}%`);
  const evolution = Object.keys(weights).map(key => {
    const history = trades.map(t => t.learning?.weightsAfter?.[key]).filter(finite).reverse();
    return `${key.toUpperCase()}: ${history.length ? history.map(v => bar(v, 4)).join(" ") : "missing history"}`;
  });
  const trend = market && finite(market.ema50) && finite(market.ema200) ? (market.ema50 > market.ema200 ? "positive structure" : "negative structure") : "missing data";
  const volume = market && finite(market.volRatio) ? `${market.volRatio.toFixed(2)}x baseline` : "missing data";
  const volatility = market && finite(market.bbUpper) && finite(market.bbLower) && market.close > 0 ? `${((market.bbUpper-market.bbLower)/market.close*100).toFixed(2)}% band width` : "missing data";
  const macroValid = macroSnapshot && finite(macroSnapshot.score) && finite(macroSnapshot.updatedAt) && macroSnapshot.stale !== true;
  const macro = macroValid ? `${macroSnapshot.score}% · intensity only · ${macroSnapshot.source || "source missing"}` : "missing or stale data";
  const patternRows = patterns.length ? patterns.map(p => `${p.name}: ${p.status} (${p.outcomes}/${p.occurrences})`) : ["No validated candidates; insufficient evidence"];
  const tradeRows = trades.length ? trades.map((t, i) => `#${i + 1} result ${finite(t.net) ? (t.net*100).toFixed(2)+"%" : "missing"}; recalibration ${t.learning ? "audited" : "missing"}`) : ["No completed sample"];
  const halt = simulator?.riskControl?.halted ? `ACTIVE · ${simulator.riskControl.reason || "capital protection"}` : "inactive";
  const lines = [
    "Adaptive Strategy Intelligence Report",
    "1. Market Context", `Trend: ${trend}`, `Volume: ${volume}`, `Volatility: ${volatility}`,
    `Structure/EMA: ${trend}`, `RSI: ${finite(market?.rsi) ? market.rsi.toFixed(1) : "missing data"}`,
    `MACD: ${finite(market?.hist) ? market.hist.toFixed(4) : "missing data"}`, "S/R: confirmed structures only",
    "2. Indicator Weights", ...(weightRows.length ? weightRows : ["missing data"]),
    "3. Indicator Evolution", `Priority evolution sample: ${trades.filter(t=>t.learning?.weightsAfter).length}/100`, ...evolution,
    "4. Pattern Analysis", ...patternRows,
    "5. Macro Score", `Score/status: ${macro}`, "Policy: intensity eligibility; never directional evidence",
    "6. Trade Memory (two horizons)", `Stored: ${memory.stored}/1000`, `Priority window: ${memory.recentCount}/100; positive results: ${memory.recentWins}`,
    `Archive baseline: ${memory.archiveCount}/900; positive results: ${memory.archiveWins}`,
    `Regime drift: ${finite(memory.drift) ? (memory.drift*100).toFixed(2)+"pp" : "insufficient samples"}`,
    "7. Evolutionary Recommendations", trades.length < RECENT_MEMORY ? "Preserve bounds until the priority window matures" : "Continue bounded two-horizon recalibration",
    `Risk halt: ${halt}`, "Basket policy: fixed 10x; frozen 1% / 2% / 4% / 8% margin tranches",
    "Basket target loss cap: 10% of basket-start equity including estimated costs",
    "Liquidation model: synthetic cross-margin at 0.5% maintenance; exchange-specific reality may differ",
    "Risk disclosure: no ordinary SL; hard -10% target kill-switch, but gaps or liquidation can exceed it",
    "Local state is advisory: consistency only; authenticity requires a trusted backend"
  ];
  const width = 78;
  const safe = lines.flatMap(line => String(line).match(new RegExp(`.{1,${width - 4}}`, "g")) || [""])
    .map(line => FORBIDDEN.test(line) ? "Vocabulary policy violation suppressed" : line);
  const top = `┌${"─".repeat(width - 2)}┐`, bottom = `└${"─".repeat(width - 2)}┘`;
  return [top, ...safe.map(line => `│ ${line.padEnd(width - 4)} │`), bottom].join("\n");
}

export function reportHasForbiddenVocabulary(report) { return FORBIDDEN.test(String(report)); }

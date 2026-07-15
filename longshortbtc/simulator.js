import { WEIGHTS } from "./strategy.js";
import { detectPatternCandidates, RECENT_MEMORY, TOTAL_MEMORY } from "./institutional-intelligence.js";
import { analyzePriceVolumeDivergence, divergenceGate } from "./volume-divergence.js";

export const EXECUTION_TIMEFRAME = "1m";
export const TIMEFRAMES = ["1m", "5m", "15m", "1h"];
export { RECENT_MEMORY, TOTAL_MEMORY };
export const SIMULATOR_VERSION = 6;
export const DIVERGENCE_FEATURE_SCHEMA_VERSION = 2;
export const STRATEGY_VERSION = "institutional-1m-basket-10x-v1";
export const TF_INFLUENCE = { "1m": .40, "5m": .25, "15m": .20, "1h": .15 };
export const BASKET_MARGIN_FRACTIONS = Object.freeze([.01, .02, .04, .08]);
export const FIXED_LEVERAGE = 10;
export const ENTRY_TIERS = Object.freeze({
  normal: Object.freeze({ score: 75, agreement: 3 }),
  flexible: Object.freeze({ score: 72, agreement: 4 }),
  macro: Object.freeze({ score: 68, agreement: 3, macroScore: 80 })
});

const INITIAL_BANK = 1000;
const FEE_RATE = .002;
const SLIPPAGE = .001;
const GLOBAL_FLOOR = 800;
const ONE_MINUTE = 60_000;
const MACRO_MAX_AGE = 30 * ONE_MINUTE;
const MAINTENANCE_MARGIN_RATE = .005;
const CONTEXT_MAX_AGE = { "1m": ONE_MINUTE, "5m": 5*ONE_MINUTE, "15m": 15*ONE_MINUTE, "1h": 60*ONE_MINUTE };
const STRUCTURAL_PARTIAL_FRACTION = .25;
const EPS = 1e-8;
const finite = Number.isFinite;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const isValidCandle = c => c && ["time", "closeTime", "open", "high", "low", "close"]
  .every(k => finite(c[k]) && c[k] > 0) && c.low <= Math.min(c.open, c.close)
  && c.high >= Math.max(c.open, c.close) && c.closeTime >= c.time;

function learningMetadata(steps = 0) {
  return { version: 2, strategyVersion: STRATEGY_VERSION, algorithm: "two-horizon-basket-v1", steps };
}

export function createSimulator(now = Date.now()) {
  return {
    version: SIMULATOR_VERSION, strategyVersion: STRATEGY_VERSION,
    initialBank: INITIAL_BANK, bank: INITIAL_BANK, position: null, pendingReversal: null,
    trades: [], weights: { ...WEIGHTS }, learningSteps: 0, learning: learningMetadata(),
    lastEntryKey: null, lastProcessedCloseTime: null, decisionSnapshots: [],
    riskControl: { halted: false, reason: null, haltedAt: null, threshold: GLOBAL_FLOOR }, startedAt: now
  };
}

function validWeights(w) { return w && Object.keys(WEIGHTS).every(k => finite(w[k]) && w[k] > 0); }
function normalizeWeights(w) {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.keys(WEIGHTS).map(k => [k, w[k] / sum * 100]));
}
export function weightsFromTradeMemory(trades = []) {
  const all = Array.isArray(trades) ? trades.slice(0, TOTAL_MEMORY) : [];
  const recent = all.slice(0, RECENT_MEMORY), archive = all.slice(RECENT_MEMORY);
  const score = (rows, key, decay) => {
    let n = 0, d = 0;
    rows.forEach((t, i) => { if (!finite(t.net) || !finite(t.parts?.[key])) return;
      const reward = clamp(t.net / .05, -1, 1) * (t.net < 0 ? 1.35 : .75);
      const weight = decay && rows.length > 1 ? 1 - .5 * i / (rows.length - 1) : 1;
      n += reward * clamp(t.parts[key] * (t.side === "long" ? 1 : -1), -1, 1) * weight; d += weight;
    }); return d ? n / d : null;
  };
  const adjusted = {};
  for (const key of Object.keys(WEIGHTS)) {
    const r = score(recent, key, true), h = score(archive, key, false);
    let s = r == null ? h || 0 : h == null ? r : .75 * r + .25 * h;
    if (r != null && r < 0) s = Math.min(s, r * .5);
    adjusted[key] = WEIGHTS[key] * (1 + .12 * clamp(s, -1, 1));
  }
  return normalizeWeights(adjusted);
}

function validLeg(l, baseline, index, side) {
  const expected = baseline * BASKET_MARGIN_FRACTIONS[index];
  return l && l.index === index + 1 && l.leverage === FIXED_LEVERAGE && finite(l.fillPrice) && l.fillPrice > 0
    && finite(l.rawPrice) && l.rawPrice > 0 && finite(l.entryFee) && l.entryFee >= 0
    && Math.abs(l.fillPrice-executionPrice(l.rawPrice,side,true))<EPS
    && Math.abs(l.entryFee-l.notional*FEE_RATE)<EPS
    && Math.abs(l.margin - expected) < EPS && Math.abs(l.notional - l.margin * FIXED_LEVERAGE) < EPS
    && finite(l.remainingNotional) && l.remainingNotional >= -EPS && l.remainingNotional <= l.notional + EPS;
}
function replaySlices(p){
  if(!Array.isArray(p.partials))return null;
  const remaining=p.legs.map(l=>l.notional),canonical=[];let lastTime=-Infinity,lastSequence=0;
  for(const stored of p.partials){
    if(!stored||stored.side!==p.side||!finite(stored.time)||stored.time<lastTime||!Number.isInteger(stored.sequence)||stored.sequence<=lastSequence
      ||!finite(stored.fillPrice)||stored.fillPrice<=0||!finite(stored.rawPrice)||stored.rawPrice<=0||!Array.isArray(stored.allocations)||stored.allocations.length!==p.legs.length)return null;
    const canonicalFill=executionPrice(stored.rawPrice,p.side,false);if(Math.abs(stored.fillPrice-canonicalFill)>EPS||(finite(stored.price)&&Math.abs(stored.price-canonicalFill)>EPS))return null;
    let gross=0,rawGross=0,closed=0;const allocations=[];let ratio=null;
    for(let i=0;i<p.legs.length;i++){
      const a=stored.allocations[i],leg=p.legs[i],pre=remaining[i];
      if(!a||a.legIndex!==i+1||!finite(a.preRemaining)||Math.abs(a.preRemaining-pre)>EPS||!finite(a.closedNotional)||a.closedNotional<0||a.closedNotional>pre+EPS||!finite(a.postRemaining)||Math.abs(a.postRemaining-(pre-a.closedNotional))>EPS)return null;
      const r=pre>EPS?a.closedNotional/pre:0;if(ratio===null&&pre>EPS)ratio=r;else if(pre>EPS&&Math.abs(r-ratio)>EPS)return null;
      const entryCost=leg.entryFee*(a.closedNotional/leg.notional);if(!finite(a.entryCostAllocation)||Math.abs(a.entryCostAllocation-entryCost)>EPS)return null;
      gross+=a.closedNotional*direction(p.side)*(canonicalFill/leg.fillPrice-1);rawGross+=a.closedNotional*direction(p.side)*(stored.rawPrice/leg.fillPrice-1);closed+=a.closedNotional;remaining[i]=a.postRemaining;
      allocations.push({legIndex:i+1,preRemaining:pre,closedNotional:a.closedNotional,postRemaining:a.postRemaining,entryCostAllocation:entryCost});
    }
    if(closed<=EPS)return null;const fee=closed*FEE_RATE,slippageCost=Math.max(0,rawGross-gross),pnl=gross-fee;
    if(![stored.notional,stored.gross,stored.fee,stored.slippageCost,stored.pnl].every(finite)||Math.abs(stored.notional-closed)>EPS||Math.abs(stored.gross-gross)>EPS||Math.abs(stored.fee-fee)>EPS||Math.abs(stored.slippageCost-slippageCost)>EPS||Math.abs(stored.pnl-pnl)>EPS)return null;
    canonical.push({...stored,price:canonicalFill,fillPrice:canonicalFill,notional:closed,gross,fee,slippageCost,pnl,allocations});lastTime=stored.time;lastSequence=stored.sequence;
  }
  if(!p.legs.every((l,i)=>Math.abs(l.remainingNotional-remaining[i])<EPS))return null;
  return canonical;
}
function canonicalCompletedTrade(stored){
  if(!stored||!validBasket(stored)||!finite(stored.exitTime)||!finite(stored.pnl)||!finite(stored.net))return null;
  const trade=structuredClone(stored),slices=replaySlices(trade);if(!slices||!trade.legs.every(l=>l.remainingNotional<=EPS))return null;
  if(!Object.hasOwn(stored,"entryDecision"))trade.entryDecision=legacyDivergenceMarker();
  else if(isLegacyDivergenceMarker(stored.entryDecision))trade.entryDecision=legacyDivergenceMarker();
  else{const entry=canonicalDecisionSnapshots([trade.entryDecision])[0];if(!entry||!entry.opened||entry.side!==trade.side)return null;trade.entryDecision=entry;}
  const pnl=-trade.legs.reduce((s,l)=>s+l.entryFee,0)+slices.reduce((s,x)=>s+x.pnl,0),net=pnl/trade.baselineEquity;
  if(Math.abs(stored.pnl-pnl)>EPS||Math.abs(stored.net-net)>EPS)return null;
  trade.partials=slices;trade.pnl=trade.pnlCurrency=pnl;trade.net=trade.netRoi=net;return trade;
}
function validBasket(p) {
  return p && ["long", "short"].includes(p.side) && finite(p.baselineEquity) && p.baselineEquity > 0
    && Array.isArray(p.legs) && p.legs.length >= 1
    && p.legs.length <= 4 && p.legs.every((l, i) => validLeg(l, p.baselineEquity, i, p.side));
}
function validDivergenceResult(d) {
  return d && d.divergenceSchemaVersion===2 && ["detected","neutral","unavailable"].includes(d.status)
    && ["bullish","bearish","none","ambiguous"].includes(d.divergence)
    && finite(d.strength) && d.strength >= 0 && d.strength <= 100
    && d.method === "confirmed-pivot-volume-obv-ad-v1" && finite(d.evaluatedAt)
    && Number.isInteger(d.barsUsed) && d.barsUsed >= 0 && d.barsUsed <= 160
    && ["quoteVolume","baseVolume-fallback","unavailable"].includes(d.volumeSource)
    && typeof d.reason === "string" && d.reason.length <= 240;
}
function canonicalDivergenceResult(d){
  if(!d||typeof d!=="object")return null;
  let candidate=d;
  if(d.divergenceSchemaVersion!==2&&["aligned","conflicting","neutral","unavailable"].includes(d.status)&&finite(d.confidence)){
    const unavailable=d.status==="unavailable"||d.volumeSource==="unavailable";
    const detected=!unavailable&&["bullish","bearish","ambiguous"].includes(d.divergence);
    candidate={...d,divergenceSchemaVersion:2,status:unavailable?"unavailable":detected?"detected":"neutral",strength:d.confidence};
  }
  if(!validDivergenceResult(candidate))return null;
  d=candidate;
  const n=v=>finite(v)?v:null,pivot=p=>p&&typeof p==="object"?{index:Number.isInteger(p.index)?p.index:null,time:n(p.time),price:n(p.price),relativeVolume:n(p.relativeVolume),confirmedAt:n(p.confirmedAt)}:null;
  const components=d.components&&typeof d.components==="object"?Object.fromEntries(Object.entries(d.components).filter(([k,v])=>["rawExhaustion","obvConfirmation","adConfirmation","obvDelta","adDelta"].includes(k)&&(["boolean","number"].includes(typeof v))&&v===v).slice(0,5)):null;
  const pivots=d.pivots?.pivot1||d.pivots?.pivot2?{pivot1:pivot(d.pivots.pivot1),pivot2:pivot(d.pivots.pivot2),separation:n(d.pivots.separation),confirmationAge:n(d.pivots.confirmationAge)}:null;
  return{divergenceSchemaVersion:2,status:d.status,divergence:d.divergence,strength:d.strength,method:d.method,evaluatedAt:d.evaluatedAt,barsUsed:d.barsUsed,volumeSource:d.volumeSource,pivots,components,reason:d.reason};
}
function legacyDivergenceMarker(){return{divergenceFeatureSchemaVersion:0,auditStatus:"legacy-pre-divergence",evaluated:false,reason:"not evaluated"};}
function isLegacyDivergenceMarker(x){return x&&x.divergenceFeatureSchemaVersion===0&&x.auditStatus==="legacy-pre-divergence"&&x.evaluated===false&&x.reason==="not evaluated";}
function canonicalDecisionSnapshots(rows) {
  if (!Array.isArray(rows)) return [];
  const seen=new Set(),out=[];
  for(const row of rows){const key=row?.closeTime;
    const divergence=canonicalDivergenceResult(row?.divergence);
    if(seen.has(key)||row?.divergenceFeatureSchemaVersion!==DIVERGENCE_FEATURE_SCHEMA_VERSION||!["long","short"].includes(row?.side)||!finite(row?.closeTime)||!divergence||divergence.evaluatedAt!==row.closeTime||typeof row.opened!=="boolean")continue;
    const gate=divergenceGate(row.side,divergence);if(row.opened!==gate.allowed)continue;
    seen.add(key);out.push({divergenceFeatureSchemaVersion:DIVERGENCE_FEATURE_SCHEMA_VERSION,closeTime:row.closeTime,side:row.side,opened:row.opened,gate,divergence,consensus:row.consensus&&typeof row.consensus==="object"?structuredClone(row.consensus):null,macro:row.macro&&typeof row.macro==="object"?structuredClone(row.macro):null,setupClass:["strong","flexible-confirmed","weak-with-fresh-macro"].includes(row.setupClass)?row.setupClass:"strong"});if(out.length===100)break;
  }return out;
}

export function migrateSimulator(raw, now = Date.now()) {
  // Version 6 is a deliberate incompatible reset: old single-position keys,
  // trades and adaptive-leverage state are never imported.
  if (!raw || raw.version !== SIMULATOR_VERSION || raw.strategyVersion !== STRATEGY_VERSION
      || !finite(raw.bank) || raw.bank < 0 || !validWeights(raw.weights)) return createSimulator(now);
  const fresh = createSimulator(now);
  const trades = Array.isArray(raw.trades) ? raw.trades.map(canonicalCompletedTrade).filter(Boolean)
    .sort((a,b)=>b.exitTime-a.exitTime).slice(0,TOTAL_MEMORY) : [];
  let position = null, canonicalBank=raw.bank;
  const entryAbsent=raw.position&&!Object.hasOwn(raw.position,"entryDecision"),entryLegacy=isLegacyDivergenceMarker(raw.position?.entryDecision);
  const persistedEntry=entryAbsent||entryLegacy?legacyDivergenceMarker():canonicalDecisionSnapshots(raw.position?.entryDecision?[raw.position.entryDecision]:[])[0];
  if(raw.position && validBasket(raw.position) && (isLegacyDivergenceMarker(persistedEntry)||(persistedEntry?.opened&&persistedEntry.side===raw.position.side))) {
    const p=structuredClone(raw.position);
    p.entryDecision=persistedEntry;
    const replayed=replaySlices(p);if(!replayed)return {...fresh};p.partials=replayed;
    const replayExitFees=p.partials.reduce((s,x)=>s+x.fee,0),replayRealized=p.partials.reduce((s,x)=>s+x.pnl,0),replayRemaining=p.legs.reduce((s,l)=>s+l.remainingNotional,0);
    if(!finite(p.exitFeesPaid)||Math.abs(p.exitFeesPaid-replayExitFees)>EPS||!finite(p.realizedPnl)||Math.abs(p.realizedPnl-replayRealized)>EPS||!finite(p.remainingNotional)||Math.abs(p.remainingNotional-replayRemaining)>EPS)return {...fresh};
    p.totalMargin=p.legs.reduce((s,l)=>s+l.margin,0);p.totalNotional=p.legs.reduce((s,l)=>s+l.notional,0);
    p.entryFeesPaid=p.legs.reduce((s,l)=>s+l.entryFee,0);p.remainingNotional=p.legs.reduce((s,l)=>s+l.remainingNotional,0);
    p.exitFeesPaid=replayExitFees;p.realizedPnl=replayRealized;p.feesPaid=p.entryFeesPaid+p.exitFeesPaid;
    p.usedZones=Array.isArray(p.usedZones)?p.usedZones.filter(z=>z&&typeof z.id==="string"&&finite(z.level)):[];
    p.structuralPartials=Array.isArray(p.structuralPartials)?p.structuralPartials.filter(x=>x&&finite(x.level)&&typeof x.reason==="string").slice(0,2):[];
    p.pendingAdd=p.pendingAdd&&p.pendingAdd.zone&&typeof p.pendingAdd.zone.id==="string"&&finite(p.pendingAdd.confirmedAt)&&finite(p.pendingAdd.referencePrice)?p.pendingAdd:null;
    p.effectiveFloor=Math.max(p.baselineEquity*.90,GLOBAL_FLOOR);refresh(p);p.riskBoundary=riskPrice(p,raw.bank);p.liquidationBoundary=liquidationPrice(p,raw.bank);
    if(finite(p.riskBoundary)&&p.riskBoundary>0&&finite(p.liquidationBoundary)&&p.liquidationBoundary>0){canonicalBank=p.baselineEquity-p.entryFeesPaid+p.realizedPnl;if(Math.abs(raw.bank-canonicalBank)>EPS)return {...fresh};position=p;p.riskBoundary=riskPrice(p,canonicalBank);p.liquidationBoundary=liquidationPrice(p,canonicalBank);}
  }
  const persistedHalt=raw.riskControl?.halted||canonicalBank<=GLOBAL_FLOOR;
  return { ...fresh, bank: canonicalBank, weights: weightsFromTradeMemory(trades), trades, position,
    learningSteps: trades.length, learning: learningMetadata(trades.length),
    lastProcessedCloseTime: finite(raw.lastProcessedCloseTime) ? raw.lastProcessedCloseTime : null,
    decisionSnapshots: canonicalDecisionSnapshots(raw.decisionSnapshots),
    riskControl: persistedHalt ? { halted: true, reason: String(raw.riskControl?.reason || "Global 20% equity halt"), haltedAt: raw.riskControl?.haltedAt || now, threshold: GLOBAL_FLOOR } : fresh.riskControl };
}

export function selectLeverage() {
  return { leverage: FIXED_LEVERAGE, reason: "Fixed basket policy", bindingCap: "fixed-policy" };
}

function confirmedPivots(candles, cutoff) {
  const rows = candles.filter(c => c.closeTime <= cutoff);
  const out = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const five = rows.slice(i - 2, i + 3), c = rows[i];
    if (five.every((x,j)=>j===2 || c.low < x.low)) out.push({ type:"support", source:`pivot:${c.closeTime}`, level:c.low });
    if (five.every((x,j)=>j===2 || c.high > x.high)) out.push({ type:"resistance", source:`pivot:${c.closeTime}`, level:c.high });
  }
  return out;
}

export function planStructuralPartials(side, market, candles) {
  const levels = [];
  for (const [key, reason] of [["ema50","EMA 50"],["ema200","EMA 200"]]) {
    const level = market[key]; if (finite(level) && (side === "long" ? level > market.close : level < market.close)) levels.push({ level, type:"ema", reason });
  }
  for (const p of confirmedPivots(candles, market.closeTime)) if ((side === "long" && p.type === "resistance" && p.level > market.close)
      || (side === "short" && p.type === "support" && p.level < market.close)) levels.push({ level:p.level, type:p.type, reason:`Confirmed swing ${p.type}` });
  levels.sort((a,b)=>side === "long" ? a.level-b.level : b.level-a.level);
  return levels.filter((x,i,a)=>!i || Math.abs(x.level-a[i-1].level)/x.level>.001).slice(0,2)
    .map((x,i)=>({ ...x, order:i+1, fraction:STRUCTURAL_PARTIAL_FRACTION, executed:false }));
}

export function getConsensus(currentByTf) {
  let long = 0, short = 0, agreementLong = 0, agreementShort = 0;
  for (const tf of TIMEFRAMES) { const s=currentByTf?.[tf]; if (!s) continue; long += s.long*TF_INFLUENCE[tf]; short += s.short*TF_INFLUENCE[tf]; if(s.long>=60)agreementLong++;if(s.short>=60)agreementShort++; }
  return { long, short, agreementLong, agreementShort, agreement:Math.max(agreementLong,agreementShort) };
}

function adverse(side, price, average) { return side === "long" ? price < average : price > average; }
function direction(side) { return side === "long" ? 1 : -1; }
function executionPrice(price, side, opening) { return price * (1 + direction(side) * SLIPPAGE * (opening ? 1 : -1)); }
function weightedAverage(legs) { const n=legs.reduce((s,l)=>s+l.fillPrice*l.remainingNotional,0), d=legs.reduce((s,l)=>s+l.remainingNotional,0); return d ? n/d : 0; }
function openGross(p, price) { return p.legs.reduce((sum,l)=>sum + l.remainingNotional * direction(p.side) * (price/l.fillPrice-1),0); }
function exitReserve(p) { return p.remainingNotional * FEE_RATE; }
function refresh(p) { p.remainingNotional=p.legs.reduce((s,l)=>s+l.remainingNotional,0);p.weightedAverage=weightedAverage(p.legs);p.entry=p.weightedAverage;p.capital=p.totalMargin;p.leverage=FIXED_LEVERAGE;p.remainingFraction=p.totalNotional?p.remainingNotional/p.totalNotional:0;p.partialTaken=p.partials.length>0; }
function riskPrice(p, bank) {
  const floor = p.effectiveFloor, target = floor - bank + exitReserve(p);
  const coefficient = p.legs.reduce((s,l)=>s + l.remainingNotional/l.fillPrice,0) * direction(p.side);
  const amountPerPrice=p.legs.reduce((s,l)=>s+l.remainingNotional/l.fillPrice,0);
  const requiredExitFill=amountPerPrice ? (target*direction(p.side)+p.remainingNotional)/amountPerPrice : null;
  return requiredExitFill ? requiredExitFill/(1-direction(p.side)*SLIPPAGE) : null;
}
function liquidationPrice(p,bank){
  const amountPerPrice=p.legs.reduce((s,l)=>s+l.remainingNotional/l.fillPrice,0), target=p.remainingNotional*MAINTENANCE_MARGIN_RATE-bank;
  const solved=amountPerPrice?(target*direction(p.side)+p.remainingNotional)/amountPerPrice:null;
  return finite(solved)?Math.max(Number.MIN_VALUE,solved):null;
}
function addLeg(sim, p, rawPrice, time, zone=null) {
  const i=p.legs.length, margin=p.baselineEquity*BASKET_MARGIN_FRACTIONS[i], notional=margin*FIXED_LEVERAGE;
  const fillPrice=executionPrice(rawPrice,p.side,true), fee=notional*FEE_RATE;
  sim.bank-=fee; p.entryFeesPaid+=fee; p.feesPaid+=fee; p.totalMargin+=margin;p.totalNotional+=notional;
  p.legs.push({ index:i+1, marginFraction:BASKET_MARGIN_FRACTIONS[i], margin, leverage:FIXED_LEVERAGE, notional,
    remainingNotional:notional, rawPrice, fillPrice, time, entryFee:fee, zoneEvidence:zone });
  refresh(p);p.riskBoundary=riskPrice(p,sim.bank);p.liquidationBoundary=liquidationPrice(p,sim.bank);
  const executed=p.structuralPartials.filter(x=>x.executed),remaining=Math.max(0,2-executed.length);
  p.structuralPartials=[...executed,...planStructuralPartials(p.side,{...p.lastMarket,close:p.weightedAverage},p.closedRows||[]).filter(x=>!p.structuralPartials.some(old=>old.type===x.type&&Math.abs(old.level-x.level)/x.level<.001)).slice(0,remaining)];
}

export function detectBounceZone(side, market, candles, position) {
  if (!position || position.legs.length >= 4 || !adverse(side, market.close, position.weightedAverage)) return null;
  const atr = finite(market.atr14) ? market.atr14 : Math.max(...candles.slice(-14).map(c=>c.high-c.low),0);
  const tolerance=Math.max(market.close*.002,atr*.25), anchors=[];
  for(const [key,label] of [["ema50","ema50"],["ema200","ema200"],[side==="long"?"bbLower":"bbUpper","bollinger"]]) if(finite(market[key])&&Math.abs(market.close-market[key])<=tolerance)anchors.push({type:label,source:label,level:market[key]});
  const pivots=confirmedPivots(candles,market.closeTime).filter(p=>p.type===(side==="long"?"support":"resistance")&&Math.abs(market.close-p.level)<=tolerance);anchors.push(...pivots);
  if(!anchors.length)return null;
  const prev=candles.at(-2), reactions=[];
  if(finite(market.rsi)&&((side==="long"&&market.rsi<=35)||(side==="short"&&market.rsi>=65)))reactions.push("rsi-extreme");
  if(finite(market.hist)&&finite(prev?.hist)&&((side==="long"&&market.hist>prev.hist)||(side==="short"&&market.hist<prev.hist)))reactions.push("macd-improvement");
  const candle=candles.at(-1);if(candle&&((side==="long"&&candle.close>candle.open&&(candle.open-candle.low)>(candle.high-candle.close))||(side==="short"&&candle.close<candle.open&&(candle.high-candle.open)>(candle.close-candle.low))))reactions.push("rejection-close");
  if(!reactions.length)return null;
  const a=anchors[0], quantum=Math.round(a.level/(Math.max(market.close*.001,atr*.25)||1));
  return {...a,reactions,confluence:2,id:`${a.type}:${a.source}:${quantum}`,confirmedAt:market.closeTime,atr14:atr};
}

function closeFraction(sim,p,fraction,rawPrice,time,reason) {
  const total=p.remainingNotional, amount=Math.min(total,total*fraction);if(amount<=0)return;
  const fill=executionPrice(rawPrice,p.side,false), ratio=amount/total;let gross=0,rawGross=0;const allocations=[];
  for(const leg of p.legs){const pre=leg.remainingNotional,cut=pre*ratio;gross+=cut*direction(p.side)*(fill/leg.fillPrice-1);rawGross+=cut*direction(p.side)*(rawPrice/leg.fillPrice-1);leg.remainingNotional-=cut;allocations.push({legIndex:leg.index,preRemaining:pre,closedNotional:cut,postRemaining:leg.remainingNotional,entryCostAllocation:leg.entryFee*(cut/leg.notional)});}
  const fee=amount*FEE_RATE,slippageCost=Math.max(0,rawGross-gross),pnl=gross-fee;sim.bank+=pnl;p.realizedPnl+=pnl;p.exitFeesPaid+=fee;p.feesPaid+=fee;
  p.partials.push({sequence:p.partials.length+1,side:p.side,fraction:amount/p.totalNotional,notional:amount,price:fill,fillPrice:fill,rawPrice,time,reason,gross,fee,slippageCost,pnl,allocations});refresh(p);p.riskBoundary=riskPrice(p,sim.bank);
}
function finish(sim,p,price,time,reason) {
  if(p.remainingNotional>EPS)closeFraction(sim,p,1,price,time,reason);
  const pnl=sim.bank-p.baselineEquity, net=pnl/p.baselineEquity;
  const before=p.weightsBefore||{...sim.weights},parts=p.parts||{},candidateIds=p.candidateIds||[];
  const provisional={...p,exit:price,exitTime:time,reason,pnl,pnlCurrency:pnl,net,netRoi:net,leverage:FIXED_LEVERAGE,capital:p.totalMargin,parts,candidateIds};
  const after=weightsFromTradeMemory([provisional,...sim.trades]);
  const trade={...provisional,learning:{weightsBefore:before,weightsAfter:after},causalEvidence:{version:2,parts,candidateIds,weightsBefore:before,expectedWeightsAfter:after},evidenceAvailability:"consistent-causal-evidence-v2"};
  sim.trades.unshift(trade);sim.trades=sim.trades.slice(0,TOTAL_MEMORY);sim.position=null;sim.learningSteps++;sim.learning=learningMetadata(sim.learningSteps);sim.weights=weightsFromTradeMemory(sim.trades);
  if(sim.bank<=GLOBAL_FLOOR+EPS){sim.riskControl={halted:true,reason:"Global 20% equity halt",haltedAt:time,threshold:GLOBAL_FLOOR};}
}

function openBasket(sim, side, market, candle, entryDecision = null) {
  const baseline=sim.bank,p={side,baselineEquity:baseline,lossAllowance:baseline*.10,effectiveFloor:Math.max(baseline*.90,GLOBAL_FLOOR),
    entryTime:candle.closeTime,legs:[],totalMargin:0,totalNotional:0,remainingNotional:0,remainingFraction:1,weightedAverage:0,
    entryFeesPaid:0,exitFeesPaid:0,feesPaid:0,realizedPnl:0,partials:[],structuralPartials:[],pendingAdd:null,usedZones:[],
    lastZoneTime:null,lastEvaluatedCloseTime:candle.closeTime,dataGap:false,parts:market.parts||{},timeframeScores:{},lastMarket:market,closedRows:[candle],
    riskPolicy:"10% basket-start equity target; gaps or synthetic liquidation can exceed it",
    candidateIds:detectPatternCandidates(market),weightsBefore:{...sim.weights},structuralPartialExecutions:0,entryDecision,
    liquidationPolicy:`Modeled cross-margin liquidation with ${(MAINTENANCE_MARGIN_RATE*100).toFixed(1)}% maintenance; exchange-specific reality may differ`};
  sim.position=p;addLeg(sim,p,candle.close,candle.closeTime);p.structuralPartials=planStructuralPartials(side,market,[candle]);
}

function validInputs(currentByTf,rowsByTf){
  const exec=rowsByTf?.["1m"]?.at(-1);if(!exec||!isValidCandle(exec)||currentByTf?.["1m"]?.closeTime!==exec.closeTime)return false;
  return TIMEFRAMES.every(tf=>{const x=currentByTf[tf];return x&&finite(x.long)&&finite(x.short)&&finite(x.close)&&finite(x.closeTime)&&x.closeTime<=exec.closeTime&&exec.closeTime-x.closeTime<=CONTEXT_MAX_AGE[tf];})&&rowsByTf["1m"].every(isValidCandle);
}
function macroEligible(macro,decisionTime){const available=macro?.availableFrom??macro?.observedAt??macro?.updatedAt;return finite(macro?.score)&&macro.score>=ENTRY_TIERS.macro.macroScore&&macro.stale===false&&finite(available)&&available<=decisionTime&&decisionTime-available<=MACRO_MAX_AGE;}

export function processSimulator(sim,currentByTf,rowsByTf,{macroSnapshot}={}) {
  if(!validInputs(currentByTf,rowsByTf))return{invalidData:true};
  const candle=rowsByTf["1m"].at(-1),market=currentByTf["1m"];
  if(sim.lastProcessedCloseTime===candle.closeTime)return{duplicate:true};
  if(sim.lastProcessedCloseTime&&candle.time>sim.lastProcessedCloseTime+1){if(sim.position){sim.position.pendingAdd=null;sim.position.dataGap=true;}sim.lastProcessedCloseTime=candle.closeTime;return{paused:true};}
  sim.lastProcessedCloseTime=candle.closeTime;
  if(sim.bank<=GLOBAL_FLOOR+EPS&&!sim.riskControl.halted)sim.riskControl={halted:true,reason:"Global 20% equity halt",haltedAt:candle.closeTime,threshold:GLOBAL_FLOOR};
  if(sim.riskControl.halted)return{halted:true};
  if(!sim.position){const c=getConsensus(currentByTf);
    const eligibleMacro=macroEligible(macroSnapshot,candle.closeTime);
    const qualifies=(score,agreement)=>(score>=ENTRY_TIERS.normal.score&&agreement>=ENTRY_TIERS.normal.agreement)
      ||(score>=ENTRY_TIERS.flexible.score&&agreement>=ENTRY_TIERS.flexible.agreement)
      ||(eligibleMacro&&score>=ENTRY_TIERS.macro.score&&agreement>=ENTRY_TIERS.macro.agreement);
    const long=qualifies(c.long,c.agreementLong),short=qualifies(c.short,c.agreementShort);
    if(long||short){const side=long?"long":"short",divergence=analyzePriceVolumeDivergence(rowsByTf["1m"]),gate=divergenceGate(side,divergence);
      const score=side==="long"?c.long:c.short,agreement=side==="long"?c.agreementLong:c.agreementShort;
      const setupClass=score>=ENTRY_TIERS.normal.score&&agreement>=ENTRY_TIERS.normal.agreement?"strong"
        :score>=ENTRY_TIERS.flexible.score&&agreement>=ENTRY_TIERS.flexible.agreement?"flexible-confirmed":"weak-with-fresh-macro";
      const snapshot={divergenceFeatureSchemaVersion:DIVERGENCE_FEATURE_SCHEMA_VERSION,closeTime:candle.closeTime,side,opened:gate.allowed,gate,divergence,consensus:{...c},macro:{eligible:eligibleMacro,score:finite(macroSnapshot?.score)?macroSnapshot.score:null},setupClass};
      sim.decisionSnapshots=canonicalDecisionSnapshots([snapshot,...(sim.decisionSnapshots||[])]);
      if(gate.allowed)openBasket(sim,side,market,candle,structuredClone(snapshot));
      return{opened:gate.allowed,blocked:!gate.allowed,divergence:gate};}
    return{opened:false};}
  const p=sim.position;p.dataGap=false;p.lastMarket=market;p.closedRows=rowsByTf["1m"].filter(x=>x.closeTime<=candle.closeTime);p.lastEvaluatedCloseTime=candle.closeTime;
  // Immutable pre-add basket is always tested at the new open first.
  p.riskBoundary=riskPrice(p,sim.bank);p.liquidationBoundary=liquidationPrice(p,sim.bank);
  const preAddLiquidated=p.side==="long"?candle.open<=p.liquidationBoundary:candle.open>=p.liquidationBoundary;
  const preAddRisk=p.side==="long"?candle.open<=p.riskBoundary:candle.open>=p.riskBoundary;
  if(preAddLiquidated||preAddRisk){p.pendingAdd=null;finish(sim,p,candle.open,candle.time,preAddLiquidated?"Modeled cross-margin liquidation gap":"Basket risk gap");return{closed:true};}
  // Pending additions execute only at the exact next one-minute open.
  if(p.pendingAdd){const expected=p.pendingAdd.confirmedAt+1;
    const invalid=candle.time!==expected||!adverse(p.side,candle.open,p.weightedAverage)||p.legs.length>=4||Math.abs(candle.open/p.pendingAdd.referencePrice-1)>.03;
    if(invalid)p.pendingAdd=null;else{addLeg(sim,p,candle.open,candle.time,p.pendingAdd.zone);p.usedZones.push(p.pendingAdd.zone);p.lastZoneTime=p.pendingAdd.confirmedAt;p.pendingAdd=null;}}
  p.riskBoundary=riskPrice(p,sim.bank);p.liquidationBoundary=liquidationPrice(p,sim.bank);const openRisk=p.side==="long"?candle.open<=p.riskBoundary:candle.open>=p.riskBoundary;
  if(openRisk){finish(sim,p,candle.open,candle.time,"Basket risk gap");return{closed:true};}
  // After a safe open, the first boundary encountered along the adverse path
  // binds: highest on a long/down path, lowest on a short/up path.
  const liquidationBinds=p.side==="long"?p.liquidationBoundary>p.riskBoundary:p.liquidationBoundary<p.riskBoundary;
  const bindingBoundary=liquidationBinds?p.liquidationBoundary:p.riskBoundary;
  const intrabarBoundaryHit=p.side==="long"?candle.low<=bindingBoundary:candle.high>=bindingBoundary;
  if(intrabarBoundaryHit){
    const rawAtBoundary=liquidationBinds?bindingBoundary/(1-direction(p.side)*SLIPPAGE):bindingBoundary;
    finish(sim,p,rawAtBoundary,candle.closeTime,liquidationBinds?"Modeled cross-margin liquidation intrabar":"Hard basket loss boundary");return{closed:true};
  }
  for(const plan of p.structuralPartials){if(plan.executed||p.remainingFraction<=.25+EPS)continue;const hit=p.side==="long"?candle.high>=plan.level:candle.low<=plan.level;if(hit){closeFraction(sim,p,STRUCTURAL_PARTIAL_FRACTION/p.remainingFraction,plan.level,candle.closeTime,`Structural partial: ${plan.reason}`);plan.executed=true;plan.executedAt=candle.closeTime;}}
  if(p.remainingNotional<=EPS){finish(sim,p,candle.close,candle.closeTime,"All partials completed");return{closed:true};}
  if(!p.pendingAdd&&p.legs.length<4){const zone=detectBounceZone(p.side,market,p.closedRows,p),spacing=Math.max(market.close*.003,(zone?.atr14||0)*.5);
    const unique=zone&&!p.usedZones.some(z=>z.id===zone.id||Math.abs(z.level-zone.level)<spacing),cooled=zone&&(!p.lastZoneTime||zone.confirmedAt-p.lastZoneTime>=3*ONE_MINUTE);
    if(unique&&cooled)p.pendingAdd={zone,confirmedAt:zone.confirmedAt,expectedOpenTime:zone.confirmedAt+1,referencePrice:market.close,marginFraction:BASKET_MARGIN_FRACTIONS[p.legs.length]};
  }
  return{updated:true};
}

export function getMarkToMarket(sim,market){if(!sim.position)return{pnl:0,equity:sim.bank,pct:0,assetReturn:0,leverage:FIXED_LEVERAGE};const p=sim.position,price=market?.close;if(!finite(price)||price<=0)return{pnl:0,equity:sim.bank,pct:0,invalid:true};const unrealized=openGross(p,price)-exitReserve(p),pnl=p.realizedPnl+unrealized;return{pnl,realizedPnl:p.realizedPnl,unrealizedPnl:unrealized,equity:sim.bank+unrealized,pct:p.totalMargin?pnl/p.totalMargin*100:0,assetReturn:direction(p.side)*(price/p.weightedAverage-1)*100,leverage:FIXED_LEVERAGE,riskBoundary:p.riskBoundary};}

const finite = Number.isFinite;
const METHOD = "confirmed-pivot-volume-obv-ad-v1";
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const windowMedian = (values, index) => median(values.slice(index - 1, index + 2));

export function buildObv(closes, volumes) {
  if (!Array.isArray(closes) || closes.length !== volumes?.length || !closes.every(finite) || !volumes.every(v => finite(v) && v >= 0)) return null;
  const out = [0];
  for (let i = 1; i < closes.length; i++) out.push(out[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0));
  return out;
}

export function buildAccumulationDistribution(candles, volumes) {
  if (!Array.isArray(candles) || candles.length !== volumes?.length) return null;
  let total = 0;
  return candles.map((c, i) => {
    if (![c?.high, c?.low, c?.close, volumes[i]].every(finite) || volumes[i] < 0) return NaN;
    total += c.high === c.low ? 0 : ((2 * c.close - c.high - c.low) / (c.high - c.low)) * volumes[i];
    return total;
  });
}

export function selectVolumeSource(candles) {
  if (!Array.isArray(candles) || !candles.length) return { available:false, source:"unavailable", reason:"No closed one-minute bars" };
  if (candles.every(c => finite(c.quoteVolume) && c.quoteVolume > 0)) return { available:true, source:"quoteVolume", values:candles.map(c => c.quoteVolume), fallback:false };
  if (candles.every(c => finite(c.volume) && c.volume > 0)) return { available:true, source:"baseVolume-fallback", values:candles.map(c => c.volume), fallback:true };
  return { available:false, source:"unavailable", reason:"Missing, non-finite, negative, or zero volume" };
}

function atrAt(candles, index, period = 14) {
  if (index < period) return null;
  const tr = [];
  for (let i = index - period + 1; i <= index; i++) tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  return tr.every(finite) ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
}

function confirmedPivots(candles) {
  const lastEligible = candles.length - 4;
  const lows = [], highs = [];
  for (let i = 3; i <= lastEligible; i++) {
    const neighbors = candles.slice(i - 3, i + 4);
    if (neighbors.every((c, j) => j === 3 || candles[i].low < c.low)) lows.push(i);
    if (neighbors.every((c, j) => j === 3 || candles[i].high > c.high)) highs.push(i);
  }
  return { lows, highs };
}

function candidate(kind, indices, candles, volumes, obv, ad) {
  if (indices.length < 2) return null;
  const i2 = indices.at(-1), i1 = indices.at(-2), separation = i2 - i1, age = candles.length - 1 - (i2 + 3);
  if (separation < 6 || separation > 30 || age > 10) return null;
  const price1 = kind === "bullish" ? candles[i1].low : candles[i1].high;
  const price2 = kind === "bullish" ? candles[i2].low : candles[i2].high;
  const atr14 = atrAt(candles, i2);
  if (!finite(atr14)) return null;
  const displacement = kind === "bullish" ? price1 - price2 : price2 - price1;
  const priceThreshold = Math.max(price1 * .0015, atr14 * .35);
  const base1 = median(volumes.slice(Math.max(0, i1 - 50), i1));
  const base2 = median(volumes.slice(Math.max(0, i2 - 50), i2));
  const pv1 = windowMedian(volumes, i1), pv2 = windowMedian(volumes, i2);
  if (![base1, base2, pv1, pv2].every(v => finite(v) && v > 0)) return null;
  const relVol1 = pv1 / base1, relVol2 = pv2 / base2;
  const rawExhaustion = relVol2 <= .8 * relVol1 && Math.max(relVol1, relVol2) >= .75;
  const denominator = volumes.slice(i1 - 1, i2 + 2).reduce((a, b) => a + b, 0);
  const obvDelta = denominator > 0 ? (windowMedian(obv, i2) - windowMedian(obv, i1)) / denominator : 0;
  const adDelta = denominator > 0 ? (windowMedian(ad, i2) - windowMedian(ad, i1)) / denominator : 0;
  const obvConfirmation = kind === "bullish" ? obvDelta >= .08 : obvDelta <= -.08;
  const adConfirmation = kind === "bullish" ? adDelta >= .08 : adDelta <= -.08;
  const confirmations = [rawExhaustion, obvConfirmation, adConfirmation].filter(Boolean).length;
  const significant = displacement >= priceThreshold;
  let strength = confirmations >= 2 && significant ? 60 : 0;
  if (strength && confirmations === 3) strength += 15;
  if (strength && displacement >= .75 * atr14) strength += 10;
  if (strength && relVol1 >= 1.2) strength += 10;
  return { kind, strength:Math.min(100, strength), significant, confirmations, pivot1:{ index:i1,time:candles[i1].closeTime,price:price1,relativeVolume:relVol1 }, pivot2:{ index:i2,time:candles[i2].closeTime,price:price2,relativeVolume:relVol2,confirmedAt:candles[i2 + 3].closeTime }, separation, confirmationAge:age, components:{ rawExhaustion, obvConfirmation, adConfirmation, obvDelta, adDelta }, thresholds:{ price:priceThreshold, obv:.08, ad:.08, relativeVolumeDecay:.8 }, atr14, displacement };
}

export function analyzePriceVolumeDivergence(input = []) {
  const supplied = Array.isArray(input) ? input : [], decisionTime=supplied.at(-1)?.closeTime ?? null;
  const base = { divergenceSchemaVersion:2, status:"unavailable", divergence:"none", strength:0, method:METHOD, evaluatedAt:finite(decisionTime)?decisionTime:null, barsUsed:0, volumeSource:"unavailable", pivots:null, components:null, thresholds:{ minimumBars:100, analysisWindow:160, pivotLeft:3, pivotRight:3, separation:[6,30], expiry:10, strongStrength:70 }, reason:"Insufficient valid closed one-minute history" };
  if(!finite(decisionTime)||supplied.some(c=>!c||!finite(c.closeTime)||c.closeTime>decisionTime))return{...base,reason:"Future or invalid row exists in causal input"};
  const candles=supplied.slice(-160);base.barsUsed=candles.length;
  for(let i=1;i<candles.length;i++)if(candles[i].closeTime-candles[i-1].closeTime!==60000)return{...base,reason:"One-minute history is out of order, duplicated, or has an internal gap"};
  if (candles.length < 100 || !candles.every(c => [c.open,c.high,c.low,c.close,c.closeTime].every(finite) && c.high >= c.low)) return base;
  const selected = selectVolumeSource(candles);
  if (!selected.available) return { ...base, barsUsed:candles.length, reason:selected.reason };
  const closes=candles.map(c=>c.close), obv=buildObv(closes,selected.values), ad=buildAccumulationDistribution(candles,selected.values);
  if (!obv || !ad?.every(finite)) return { ...base, volumeSource:selected.source, reason:"Volume-derived series unavailable" };
  const pivots=confirmedPivots(candles), bull=candidate("bullish",pivots.lows,candles,selected.values,obv,ad), bear=candidate("bearish",pivots.highs,candles,selected.values,obv,ad);
  const validBull=bull?.significant&&bull.confirmations>=2, validBear=bear?.significant&&bear.confirmations>=2;
  if(validBull&&validBear)return{...base,status:"detected",divergence:"ambiguous",strength:Math.max(bull.strength,bear.strength),volumeSource:selected.source,pivots:{bullish:bull,bearish:bear},components:{bullish:bull.components,bearish:bear.components},reason:"Simultaneous bullish and bearish divergence evidence"};
  const found=validBull?bull:validBear?bear:null;
  if(!found)return{...base,status:"neutral",volumeSource:selected.source,pivots:{bullish:bull,bearish:bear},reason:`No current confirmed price-volume divergence${selected.fallback?"; explicit base-volume fallback":""}`};
  return{...base,status:"detected",divergence:found.kind,strength:found.strength,volumeSource:selected.source,pivots:{pivot1:found.pivot1,pivot2:found.pivot2,separation:found.separation,confirmationAge:found.confirmationAge},components:found.components,thresholds:{...base.thresholds,...found.thresholds,price:found.thresholds.price},reason:`Confirmed ${found.kind} price-volume divergence${selected.fallback?" using explicit base-volume fallback":""}`};
}

export function divergenceGate(side, result) {
  if (!result || result.status === "unavailable") return { allowed:false, status:"unavailable", reason:result?.reason || "Divergence evidence unavailable" };
  if(result.divergence==="ambiguous")return{allowed:false,status:"conflicting",reason:"Ambiguous simultaneous divergence evidence fails closed"};
  const strong=result.strength>=70, conflict=strong&&((side==="long"&&result.divergence==="bearish")||(side==="short"&&result.divergence==="bullish"));
  if(conflict)return{allowed:false,status:"conflicting",reason:`Strong ${result.divergence} divergence conflicts with proposed ${side}`};
  const aligned=strong&&((side==="long"&&result.divergence==="bullish")||(side==="short"&&result.divergence==="bearish"));
  return{allowed:true,status:aligned?"aligned":"neutral",reason:aligned?"Strong divergence is directionally aligned":"No strong conflicting divergence"};
}

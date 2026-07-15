const FOUR_HOURS = 4 * 60 * 60 * 1000;
const POST_CLOSE_DELAY = 15 * 1000;

const finite = Number.isFinite;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function parseAlpacaBars(payload) {
  const bars=payload?.bars?.["BTC/USD"];
  if(!Array.isArray(bars))return[];
  return bars.map(bar=>{const openTime=Date.parse(bar?.t);return[openTime,bar?.o,bar?.h,bar?.l,bar?.c,bar?.v,openTime+FOUR_HOURS-1];})
    .filter(row=>finite(row[0])&&finite(Number(row[1]))&&finite(Number(row[2]))&&finite(Number(row[3]))&&finite(Number(row[4]))&&finite(Number(row[5])));
}

export function calculateDirectionalContext(rawRows, observedAt = Date.now(), source = "Alpaca Market Data") {
  const rows = Array.isArray(rawRows) ? rawRows.map(row => ({
    openTime:Number(row?.[0]), open:Number(row?.[1]), high:Number(row?.[2]), low:Number(row?.[3]),
    close:Number(row?.[4]), volume:Number(row?.[5]), closeTime:Number(row?.[6])
  })).filter(row => finite(row.openTime) && finite(row.closeTime) && finite(row.open) && finite(row.high)
    && finite(row.low) && finite(row.close) && finite(row.volume) && row.close > 0 && row.closeTime <= observedAt) : [];
  if (rows.length < 8) return null;
  const sample = rows.slice(-42), latest = sample.at(-1), start = sample[Math.max(0, sample.length - 7)];
  const returns = sample.slice(1).map((row, index) => row.close / sample[index].close - 1);
  const momentum = latest.close / start.close - 1;
  const positiveShare = returns.filter(value => value > 0).length / returns.length;
  const averageVolume = sample.slice(0, -1).reduce((sum, row) => sum + row.volume, 0) / Math.max(1, sample.length - 1);
  const volumeRatio = averageVolume > 0 ? latest.volume / averageVolume : 1;
  const direction = Math.abs(momentum) < .006 ? "neutral" : momentum > 0 ? "bullish" : "bearish";
  const consistency = direction === "bullish" ? positiveShare : direction === "bearish" ? 1 - positiveShare : .5;
  const confidence = direction === "neutral" ? Math.round(clamp(35 + Math.abs(momentum) * 1000, 35, 55))
    : Math.round(clamp(45 + Math.abs(momentum) * 900 + Math.abs(consistency - .5) * 35 + Math.min(1.5, volumeRatio) * 5, 45, 90));
  return {
    schemaVersion:1, direction, confidence, asOf:latest.closeTime, observedAt,
    availableFrom:observedAt, expiresAt:latest.closeTime + FOUR_HOURS + POST_CLOSE_DELAY, stale:false,
    metrics:{ momentum:Math.round(momentum * 1000000) / 1000000, positiveShare:Math.round(positiveShare * 1000) / 1000,
      volumeRatio:Math.round(volumeRatio * 1000) / 1000, lastPrice:latest.close },
    source
  };
}

export { FOUR_HOURS, POST_CLOSE_DELAY };

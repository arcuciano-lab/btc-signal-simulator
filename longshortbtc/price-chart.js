export const DEFAULT_VISIBLE_CANDLE_COUNT = 120;

export function selectVisibleCandles(rows, count = DEFAULT_VISIBLE_CANDLE_COUNT) {
  if (!Array.isArray(rows) || count <= 0) return [];
  return rows.slice(-Math.floor(count));
}

export function calculateCandlePriceDomain(rows, paddingRatio = 0.08) {
  const prices = (Array.isArray(rows) ? rows : [])
    .flatMap(row => [row?.high, row?.low])
    .filter(Number.isFinite);

  if (!prices.length) return { min: 0, max: 1 };

  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const reference = Math.max(Math.abs(rawMin), Math.abs(rawMax), 1);
  const padding = Math.max((rawMax - rawMin) * paddingRatio, reference * 0.0005);
  return { min: rawMin - padding, max: rawMax + padding };
}

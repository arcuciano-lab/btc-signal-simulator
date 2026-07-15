export function movingAverageStrategy({ period = 3 } = {}) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError("period must be a positive integer");
  return Object.freeze({
    id: `close-above-sma-${period}`,
    decide({ candle, history }) {
      if (history.length < period) return "flat";
      const sample = history.slice(-period);
      const average = sample.reduce((sum, item) => sum + item.close, 0) / period;
      return candle.close > average ? "long" : "flat";
    }
  });
}

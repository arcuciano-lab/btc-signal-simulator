export const WEIGHTS = { rsi: 20, macd: 20, volume: 10, bands: 15, emaTrend: 25, ema50: 10 };

export function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function sma(values, period) {
  const out = Array(values.length).fill(null); let sum = 0;
  for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= period) sum -= values[i - period]; if (i >= period - 1) out[i] = sum / period; }
  return out;
}

export function rsi(values, period = 14) {
  const out = Array(values.length).fill(null); if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gains += Math.max(d, 0); losses += Math.max(-d, 0); }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period; avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period; out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss); }
  return out;
}

function std(values, period, means) {
  return values.map((_, i) => i < period - 1 ? null : Math.sqrt(values.slice(i - period + 1, i + 1).reduce((s, v) => s + (v - means[i]) ** 2, 0) / period));
}

export function analyze(candles, weights = WEIGHTS) {
  const close = candles.map(c => c.close), volumes = candles.map(c => c.volume);
  const ema12 = ema(close, 12), ema26 = ema(close, 26), ema50 = ema(close, 50), ema200 = ema(close, 200);
  const macdLine = close.map((_, i) => ema12[i] == null || ema26[i] == null ? null : ema12[i] - ema26[i]);
  const compactMacd = macdLine.filter(v => v != null), compactSignal = ema(compactMacd, 9); const signalOffset = macdLine.findIndex(v => v != null);
  const macdSignal = Array(close.length).fill(null); compactSignal.forEach((v, i) => { macdSignal[i + signalOffset] = v; });
  const rsi14 = rsi(close), volSma = sma(volumes, 20), mid = sma(close, 20), deviation = std(close, 20, mid);
  const upper = mid.map((v, i) => v == null ? null : v + 2 * deviation[i]); const lower = mid.map((v, i) => v == null ? null : v - 2 * deviation[i]);
  const rows = candles.map((c, i) => {
    if (i < 200) return { ...c, ready: false, ema50: ema50[i], ema200: ema200[i] };
    const hist = macdLine[i] - macdSignal[i]; const prevHist = macdLine[i - 1] - macdSignal[i - 1]; const volRatio = c.volume / volSma[i];
    const parts = {};
    parts.rsi = rsi14[i] >= 55 && rsi14[i] <= 72 ? 1 : rsi14[i] <= 45 && rsi14[i] >= 28 ? -1 : rsi14[i] > 72 ? -0.35 : rsi14[i] < 28 ? 0.35 : (rsi14[i] - 50) / 10;
    parts.macd = hist > 0 ? (hist >= prevHist ? 1 : .55) : (hist <= prevHist ? -1 : -.55);
    parts.volume = volRatio >= 1.1 ? Math.sign(c.close - candles[i - 1].close) : Math.sign(c.close - candles[i - 1].close) * .25;
    const bandPos = (c.close - lower[i]) / (upper[i] - lower[i] || 1); parts.bands = bandPos > .55 && bandPos < 1.05 ? .8 : bandPos < .45 && bandPos > -.05 ? -.8 : bandPos >= 1.05 ? .35 : bandPos <= -.05 ? -.35 : 0;
    parts.emaTrend = ema50[i] > ema200[i] ? 1 : -1;
    parts.ema50 = c.close > ema50[i] ? 1 : -1;
    const raw = Object.entries(parts).reduce((sum, [key, value]) => sum + value * weights[key], 0);
    const long = Math.round(Math.max(0, Math.min(100, 50 + raw / 2))); const short = 100 - long;
    return { ...c, ready: true, rsi: rsi14[i], macd: macdLine[i], macdSignal: macdSignal[i], hist, volRatio, bbUpper: upper[i], bbMid: mid[i], bbLower: lower[i], ema50: ema50[i], ema200: ema200[i], parts, long, short };
  });
  return rows;
}

export function backtest(rows, options = {}) {
  const fee = options.fee ?? .001, stop = options.stop ?? .025, target = options.target ?? .05, threshold = options.threshold ?? 68;
  let equity = 10000, position = null, peak = equity, maxDrawdown = 0; const trades = [], curve = [{ time: rows[200]?.time, equity }];
  const closePosition = (price, time, reason) => {
    const gross = position.side === "long" ? price / position.entry - 1 : position.entry / price - 1;
    const net = gross - fee * 2; equity *= 1 + net; trades.push({ ...position, exit: price, exitTime: time, net, reason }); position = null; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak); curve.push({ time, equity });
  };
  for (let i = 201; i < rows.length; i++) {
    const signal = rows[i - 1], bar = rows[i]; if (!signal.ready) continue;
    if (position) {
      const stopPrice = position.side === "long" ? position.entry * (1 - stop) : position.entry * (1 + stop);
      const targetPrice = position.side === "long" ? position.entry * (1 + target) : position.entry * (1 - target);
      const stopHit = position.side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
      const targetHit = position.side === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
      if (stopHit) closePosition(stopPrice, bar.time, "stop");
      else if (targetHit) closePosition(targetPrice, bar.time, "target");
      else if ((position.side === "long" && signal.short >= 58) || (position.side === "short" && signal.long >= 58)) closePosition(bar.open, bar.time, "flip");
    }
    if (!position) {
      if (signal.long >= threshold) position = { side: "long", entry: bar.open, entryTime: bar.time };
      else if (signal.short >= threshold) position = { side: "short", entry: bar.open, entryTime: bar.time };
    }
  }
  if (position) closePosition(rows.at(-1).close, rows.at(-1).time, "end");
  const wins = trades.filter(t => t.net > 0); const losses = trades.filter(t => t.net <= 0); const avgWin = wins.length ? wins.reduce((s,t)=>s+t.net,0)/wins.length : 0; const avgLoss = losses.length ? Math.abs(losses.reduce((s,t)=>s+t.net,0)/losses.length) : 0;
  return { equity, returnPct: (equity / 10000 - 1) * 100, trades: trades.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, profitFactor: avgLoss && losses.length ? (wins.reduce((s,t)=>s+t.net,0)) / Math.abs(losses.reduce((s,t)=>s+t.net,0)) : 0, maxDrawdown: maxDrawdown * 100, curve };
}

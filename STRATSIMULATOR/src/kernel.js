const VALID_SIGNALS = new Set(["long", "flat"]);

function assertFinite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

export function normalizeCandles(source) {
  if (!source || typeof source[Symbol.iterator] !== "function") {
    throw new TypeError("market data must be iterable");
  }
  let previousTime;
  const candles = [...source].map((raw, index) => {
    const candle = {
      time: Number(raw.time),
      open: Number(raw.open), high: Number(raw.high),
      low: Number(raw.low), close: Number(raw.close),
      volume: Number(raw.volume ?? 0)
    };
    assertFinite(candle.time, `candle[${index}].time`);
    for (const key of ["open", "high", "low", "close", "volume"])
      assertFinite(candle[key], `candle[${index}].${key}`);
    for (const key of ["open", "high", "low", "close"])
      if (candle[key] <= 0) throw new RangeError(`candle[${index}].${key} must be positive`);
    if (index && candle.time <= previousTime)
      throw new RangeError("candles must be strictly chronological");
    if (candle.low > Math.min(candle.open, candle.close) ||
        candle.high < Math.max(candle.open, candle.close))
      throw new RangeError(`invalid OHLC at candle ${index}`);
    previousTime = candle.time;
    return Object.freeze(candle);
  });
  if (candles.length < 2) throw new RangeError("at least two candles are required");
  return Object.freeze(candles);
}

function metrics(initialCash, equityCurve, trades) {
  let peak = initialCash;
  let maxDrawdown = 0;
  for (const { equity } of equityCurve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const finalEquity = equityCurve.at(-1).equity;
  return {
    initialEquity: initialCash,
    finalEquity,
    return: finalEquity / initialCash - 1,
    // Close-to-close mark-to-market drawdown; this does not estimate intrabar excursions.
    maxDrawdown,
    tradeCount: trades.length
  };
}

/**
 * Strategy contract: { id, decide({ candle, history, position }) => "long"|"flat" }.
 * Decisions see only closed candles through `candle`; fills occur at the next open.
 */
export function runBacktest({
  marketData, strategy, initialCash = 10_000, feeRate = 0, slippageRate = 0
}) {
  const candles = normalizeCandles(marketData);
  if (!strategy || typeof strategy.decide !== "function")
    throw new TypeError("strategy.decide is required");
  for (const [value, name] of [[initialCash, "initialCash"], [feeRate, "feeRate"], [slippageRate, "slippageRate"]]) {
    assertFinite(value, name);
    if (value < 0) throw new RangeError(`${name} cannot be negative`);
  }
  if (initialCash <= 0 || feeRate >= 1 || slippageRate >= 1)
    throw new RangeError("invalid backtest configuration");

  let cash = initialCash;
  let quantity = 0;
  let entry = null;
  const trades = [];
  const equityCurve = [{ time: candles[0].time, equity: cash }];

  for (let i = 0; i < candles.length - 1; i++) {
    const history = Object.freeze(candles.slice(0, i + 1));
    const signal = strategy.decide(Object.freeze({
      candle: candles[i], history, position: quantity > 0 ? "long" : "flat"
    }));
    if (!VALID_SIGNALS.has(signal)) throw new TypeError(`invalid signal: ${signal}`);
    const fillCandle = candles[i + 1];

    if (signal === "long" && quantity === 0) {
      const price = fillCandle.open * (1 + slippageRate);
      quantity = cash / (price * (1 + feeRate));
      const fee = quantity * price * feeRate;
      cash -= quantity * price + fee;
      entry = { signalTime: candles[i].time, fillTime: fillCandle.time, price, fee };
    } else if (signal === "flat" && quantity > 0) {
      const price = fillCandle.open * (1 - slippageRate);
      const fee = quantity * price * feeRate;
      cash += quantity * price - fee;
      trades.push(Object.freeze({ ...entry, exitSignalTime: candles[i].time,
        exitTime: fillCandle.time, exitPrice: price, exitFee: fee,
        pnl: cash - initialCash - trades.reduce((sum, t) => sum + t.pnl, 0) }));
      quantity = 0;
      entry = null;
    }
    equityCurve.push({ time: fillCandle.time, equity: cash + quantity * fillCandle.close });
  }

  if (quantity > 0) {
    const last = candles.at(-1);
    const price = last.close * (1 - slippageRate);
    const fee = quantity * price * feeRate;
    cash += quantity * price - fee;
    trades.push(Object.freeze({ ...entry, exitSignalTime: null, exitTime: last.time,
      exitPrice: price, exitFee: fee,
      pnl: cash - initialCash - trades.reduce((sum, t) => sum + t.pnl, 0), forced: true }));
    quantity = 0;
    equityCurve[equityCurve.length - 1] = { time: last.time, equity: cash };
  }

  return Object.freeze({ strategyId: strategy.id ?? "anonymous", trades: Object.freeze(trades),
    equityCurve: Object.freeze(equityCurve.map(Object.freeze)),
    metrics: Object.freeze(metrics(initialCash, equityCurve, trades)) });
}

# BTC Strategy Kernel

Small deterministic research kernel for **closed-candle** BTC backtests. It is intentionally
long/flat, dependency-free, and disconnected from exchanges and real money.

```bash
npm test
npm run smoke
npm run evolve
```

## Layers and extension points

- `src/kernel.js`: market-data normalization, next-open execution, costs, and metrics.
- `src/strategies.js`: replaceable strategy/agent contract (`decide` returns `long` or `flat`).
- `src/fixture.js`: replaceable iterable market-data source.
- `src/cli.js`: JSON smoke harness.
- `src/optimizer.js`: bounded exhaustive SMA search with chronological train/validation split.
- `src/evolve-cli.js`: candidate and champion trace as JSON.

Signals observe history only through the latest closed candle and execute at the next open.
The kernel models proportional fees and deterministic slippage. It does **not** yet model
shorts, leverage, funding, partial fills, latency, liquidation, autonomous optimization, or
live execution. Future learners should generate immutable strategy candidates and evaluate
them through this kernel rather than mutate a running backtest.

`metrics.maxDrawdown` is calculated from the close-to-close mark-to-market equity curve.
It deliberately makes no claim about intrabar drawdown between candle closes.

The optimizer creates fresh immutable candidates for train and validation, selects only by
validation fitness, and explicitly penalizes drawdown and too few trades. It does not mutate
strategies during evaluation or connect the selected champion to live execution.

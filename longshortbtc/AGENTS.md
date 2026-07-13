# Repository Guidelines

## Project Structure & Module Organization

This repository is a dependency-free Node.js 20 application with a vanilla browser UI.

- `server.mjs` serves static files and exposes the Binance and news proxy endpoints.
- `strategy.js` contains technical indicators, signal scoring, and backtesting logic.
- `app.js` owns browser state, chart rendering, multi-timeframe analysis, and paper trading.
- `index.html` and `styles.css` define the dashboard structure and presentation.
- `tests/strategy.test.mjs` covers the quantitative core with Node's built-in test runner.
- `render.yaml` configures deployment to Render.

Keep reusable calculations in `strategy.js`; avoid coupling them to the DOM or network code.

## Build, Test, and Development Commands

```bash
npm start     # Start the HTTP server on http://localhost:4173
npm test      # Run all tests matching tests/*.test.mjs
```

There is no build step or dependency installation requirement. Set `PORT` to override the default server port. After starting the app, check `GET /health` to verify the server is ready.

## Coding Style & Naming Conventions

Use ES modules and the existing JavaScript style: two-space indentation, semicolons, double-quoted strings, `camelCase` for functions and variables, and `UPPER_SNAKE_CASE` for constants. Prefer small pure functions for indicators and scoring. Keep browser-only behavior in `app.js` and server-only behavior in `server.mjs`.

No formatter or linter is configured, so match nearby code and keep changes focused. Preserve UTF-8 encoding when editing user-facing text.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `*.test.mjs` under `tests/`. Add deterministic tests for every strategy change, including boundary conditions and finite numeric outputs. Network, cache, and API changes should include isolated tests that do not depend on live third-party services.

Run `npm test` before requesting review.

## Commit & Pull Request Guidelines

Git history is not available in this working copy. Use Conventional Commits, for example `fix: align backtest entry threshold`. Never add AI attribution or `Co-Authored-By` trailers.

Pull requests should explain the behavior changed, identify affected modules, and include test results. Link the relevant issue when one exists. Include screenshots for dashboard or chart changes, and call out strategy assumptions or changes to trading thresholds explicitly.

## Security & Configuration

Never commit credentials; public Binance endpoints require no API key. Validate query parameters and upstream responses in `server.mjs`. Treat external feeds as unreliable and preserve graceful degradation when a source fails.

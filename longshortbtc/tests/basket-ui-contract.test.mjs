import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const app=await readFile(new URL("../app.js",import.meta.url),"utf8");
const simulator=await readFile(new URL("../simulator.js",import.meta.url),"utf8");
const report=await readFile(new URL("../institutional-intelligence.js",import.meta.url),"utf8");
test("legacy storage cleanup occurs only after successful current persistence",()=>{const write=app.indexOf("localStorage.setItem(SIM_KEY");const clean=app.indexOf("LEGACY_SIM_KEYS.forEach",write);assert.ok(write>=0&&clean>write);});
test("all known pre-basket storage keys are named for cleanup",()=>{for(const v of [1,2,3,4,5])assert.match(app,new RegExp(`btc-signal-simulator-v${v}`));});
test("UI presents recent and total memory horizons truthfully",()=>{assert.match(app,/RECENT.*\/100.*TOTAL.*\/1000/);});
test("report states modeled cross-margin and gap qualification",()=>{assert.match(report,/synthetic cross-margin at 0\.5% maintenance/);assert.match(report,/gaps or liquidation can exceed/);});
test("bounce MACD reaction uses production hist property",()=>{assert.match(simulator,/market\.hist/);assert.doesNotMatch(simulator,/macdHistogram/);});
test("price chart contains no active-trade overlay while the ASCII panel remains wired",()=>{
  for(const forbidden of [/drawOpenTradeLine/,/drawTradeLevel/,/HARD BASKET RISK/,/MODELED CROSS-MARGIN LIQUIDATION/,/PARTIAL 25%/])assert.doesNotMatch(app,forbidden);
  assert.match(app,/buildActiveTradePanel/);
  assert.match(app,/tradePanel\.textContent = panel\.text/);
});

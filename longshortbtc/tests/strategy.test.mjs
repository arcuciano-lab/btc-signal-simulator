import test from "node:test";
import assert from "node:assert/strict";
import { ema, rsi, analyze, backtest } from "../strategy.js";

test("EMA conserva longitud y arranca tras el periodo", () => { const out=ema([1,2,3,4,5],3); assert.deepEqual(out.slice(0,3),[null,null,2]); assert.equal(out.length,5); });
test("RSI de una serie ascendente converge a 100", () => { const out=rsi(Array.from({length:30},(_,i)=>i+1),14); assert.equal(out.at(-1),100); });
test("análisis y backtest no producen valores inválidos", () => {
  const candles=Array.from({length:500},(_,i)=>{const base=30000+i*18+Math.sin(i/8)*400;return {time:i*3600000,close:base,open:base-10,high:base+80,low:base-80,volume:100+Math.sin(i)*20,closeTime:i*3600000+3599999}});
  const rows=analyze(candles); const current=rows.at(-1); assert.equal(current.long+current.short,100); assert.ok(Number.isFinite(current.rsi)); const result=backtest(rows); assert.ok(Number.isFinite(result.equity)); assert.ok(result.equity>0);
});

test("el análisis acepta pesos adaptativos y conserva un score válido", () => {
  const candles=Array.from({length:500},(_,i)=>{const base=30000+i*12+Math.sin(i/7)*300;return {time:i*300000,close:base,open:base-8,high:base+60,low:base-60,volume:100+Math.cos(i)*15,closeTime:i*300000+299999}});
  const weights={rsi:10,macd:30,volume:5,bands:10,emaTrend:35,ema50:10};
  const current=analyze(candles,weights).at(-1);
  assert.equal(current.long+current.short,100);
  assert.ok(current.long>=0&&current.long<=100);
});

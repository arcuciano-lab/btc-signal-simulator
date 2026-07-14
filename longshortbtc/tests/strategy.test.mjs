import test from "node:test";
import assert from "node:assert/strict";
import { ema, rsi, analyze, backtest, canonicalVolume } from "../strategy.js";

test("EMA conserva longitud y arranca tras el periodo", () => { const out=ema([1,2,3,4,5],3); assert.deepEqual(out.slice(0,3),[null,null,2]); assert.equal(out.length,5); });
test("RSI de una serie ascendente converge a 100", () => { const out=rsi(Array.from({length:30},(_,i)=>i+1),14); assert.equal(out.at(-1),100); });
test("RSI plano es neutral y una serie descendente converge a cero", () => {
  assert.equal(rsi(Array(30).fill(100),14).at(-1),50);
  assert.equal(rsi(Array.from({length:30},(_,i)=>30-i),14).at(-1),0);
});

test("volumen canónico prefiere quote volume y degrada a base volume", () => {
  assert.equal(canonicalVolume({quoteVolume:200,volume:2}),200);
  assert.equal(canonicalVolume({quoteVolume:Number.NaN,volume:2}),2);
  assert.equal(canonicalVolume({quoteVolume:0,volume:2}),2);
  assert.equal(canonicalVolume({quoteVolume:-1,volume:Number.NaN}),null);
});

test("ratio de volumen compara la vela actual con las veinte anteriores", () => {
  const candles=Array.from({length:220},(_,i)=>({time:i,closeTime:i+1,open:100,high:100,low:100,close:100,volume:1,quoteVolume:i===219?200:100}));
  const current=analyze(candles).at(-1);
  assert.equal(current.volRatio,2);
  assert.deepEqual(current.parts,{rsi:0,macd:0,volume:0,bands:0,emaTrend:0,ema50:0});
  assert.equal(current.long,50);assert.equal(current.short,50);
});

test("volumen inválido no propaga NaN ni crea un voto", () => {
  const candles=Array.from({length:220},(_,i)=>({time:i,closeTime:i+1,open:100,high:100,low:100,close:100,volume:i===219?Number.NaN:1,quoteVolume:Number.NaN}));
  const current=analyze(candles).at(-1);
  assert.equal(current.volRatio,null);assert.equal(current.parts.volume,0);
  assert.equal(current.long+current.short,100);assert.doesNotMatch(JSON.stringify(current),/NaN/);
});

test("volumen actual cero queda no disponible y neutral", () => {
  const candles=Array.from({length:220},(_,i)=>({time:i,closeTime:i+1,open:100,high:101,low:99,close:i===219?101:100,volume:i===219?0:1,quoteVolume:i===219?0:100}));
  const current=analyze(candles).at(-1);
  assert.equal(current.volRatio,null);assert.equal(current.parts.volume,0);
});

test("ventana previa con cero o totalmente no disponible degrada a neutral", () => {
  for (const unavailable of [false,true]) {
    const candles=Array.from({length:220},(_,i)=>({time:i,closeTime:i+1,open:100,high:101,low:99,close:i===219?101:100,
      volume:i>=199&&i<219?(unavailable?Number.NaN:0):1,quoteVolume:i>=199&&i<219?(unavailable?Number.NaN:0):100}));
    const current=analyze(candles).at(-1);
    assert.equal(current.volRatio,null);assert.equal(current.parts.volume,0);
  }
});

test("una ventana quote incompleta usa base coherentemente en las veintiuna velas", () => {
  const candles=Array.from({length:220},(_,i)=>({time:i,closeTime:i+1,open:100,high:101,low:99,close:100,
    volume:i===219?40:20,quoteVolume:i===205?Number.NaN:(i===219?9000:1000)}));
  const current=analyze(candles).at(-1);
  assert.equal(current.volRatio,2);
});

test("una vela previa con quote y base en cero invalida explícitamente el ratio", () => {
  const candles=Array.from({length:220},(_,i)=>({time:i,closeTime:i+1,open:100,high:101,low:99,close:i===219?101:100,
    volume:20,quoteVolume:1000}));
  candles[210].quoteVolume=0;
  candles[210].volume=0;
  const current=analyze(candles).at(-1);
  assert.equal(current.volRatio,null);
  assert.equal(current.parts.volume,0);
});
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

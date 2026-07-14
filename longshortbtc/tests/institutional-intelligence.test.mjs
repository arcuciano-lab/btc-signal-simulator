import test from "node:test";
import assert from "node:assert/strict";
import { buildInstitutionalReport, buildPatternEvidence, reportHasForbiddenVocabulary, resolveIndicatorVote, summarizeTradeMemory, validatePattern } from "../institutional-intelligence.js";

test("institutional report has all sections, bounded width and explicit missing data", () => {
  const report = buildInstitutionalReport({ simulator: { trades: [], weights: {}, riskControl: {}, leverageLearning: {} } });
  for (let section = 1; section <= 7; section += 1) assert.match(report, new RegExp(`${section}\\.`));
  assert.match(report, /missing data/i);
  assert.equal(Math.max(...report.split("\n").map(line => line.length)), 78);
  assert.equal(reportHasForbiddenVocabulary(report), false);
});

test("indicator weights render canonical Unicode bars, percentages and a 100 percent total", () => {
  const weights = { rsi: 20, macd: 20, volume: 10, bands: 15, emaTrend: 25, ema50: 10 };
  const report = buildInstitutionalReport({ simulator: { trades: [], weights, riskControl: {} } });
  const expected = [
    ["RSI", 2, 20], ["MACD", 2, 20], ["VOLUME", 1, 10],
    ["BANDS", 2, 15], ["EMATREND", 3, 25], ["EMA50", 1, 10],
    ["TOTAL", 12, 100]
  ];

  for (const [label, fills, percentage] of expected) {
    const line = report.split("\n").find(row => row.startsWith(`| ${label}`) && row.includes("\u2588"));
    assert.ok(line, `${label} row is present`);
    assert.equal((line.match(/\u2588/g) || []).length, fills, `${label} fill count`);
    assert.match(line, new RegExp(`\\s${percentage}%\\s`));
  }
  assert.doesNotMatch(report, /â|Â|NaN/);
  assert.ok(report.split("\n").every(line => line.length === 78));
});

test("indicator weights disclose missing or non-finite metrics instead of deceptive values", () => {
  const report = buildInstitutionalReport({ simulator: { trades: [], weights: { rsi: Number.NaN }, riskControl: {} } });
  assert.match(report, /RSI\s+missing data/);
  assert.match(report, /TOTAL\s+missing data/);
  assert.doesNotMatch(report, /NaN%|â|Â/);
});

test("report separates current readings from adaptive weights and preserves EMA 50/200", () => {
  const market={close:100,rsi:50,hist:0,volRatio:2,bbLower:90,bbUpper:110,ema50:99,ema200:98};
  const weights={rsi:20,macd:20,volume:10,bands:15,emaTrend:25,ema50:10};
  const report=buildInstitutionalReport({market,simulator:{trades:[],weights,riskControl:{}}});
  assert.match(report,/Current Indicator Readings/);assert.match(report,/2\. Adaptive Indicator Weights/);
  assert.match(report,/RSI \(14\): 50\.0/);assert.match(report,/MACD histogram: 0\.0000/);
  assert.match(report,/Volume\/current vs previous 20: 2\.00x baseline/);
  assert.match(report,/Bollinger: inside bands/);assert.match(report,/EMA 50: 99\.00/);assert.match(report,/EMA 200: 98\.00/);
  assert.doesNotMatch(report,/EMA 3|NaN|â|Â/);assert.ok(report.split("\n").every(line=>line.length===78));
});

test("priority hundred dominates contradictory archive and archive cannot rescue pattern compatibility", () => {
  const recent=Array.from({length:100},()=>({net:-.01,candidateIds:["ema-alignment"]}));
  const archive=Array.from({length:900},()=>({net:.01,candidateIds:["ema-alignment"]}));
  const memory=summarizeTradeMemory([...recent,...archive]);
  assert.ok(memory.blendedMean<0); assert.equal(memory.recentCount,100); assert.equal(memory.archiveCount,900);
  const candidate={id:"ema-alignment",name:"ema",occurrences:1000,outcomes:900,netExpectancyAfterCosts:.02,successRate:.8,noLookahead:true};
  assert.equal(validatePattern(candidate,[...recent,...archive]).status,"insufficient evidence");
});

test("bounded memory summary cannot let extreme archive profit reverse a recent loss regime", () => {
  const recent=Array.from({length:100},()=>({net:-.001}));
  const archive=Array.from({length:900},()=>({net:1000}));
  const memory=summarizeTradeMemory([...recent,...archive]);
  assert.ok(memory.recentMean<0); assert.ok(memory.blendedMean<0);
});

test("report summarizes bounded horizons without rendering one thousand rows", () => {
  const trades=Array.from({length:1000},(_,i)=>({net:i<100?-.01:.01}));
  const report=buildInstitutionalReport({simulator:{trades,weights:{},riskControl:{},leverageLearning:{}}});
  assert.match(report,/Stored: 1000\/1000/); assert.match(report,/Priority window: 100\/100/); assert.match(report,/Archive baseline: 900\/900/);
  assert.ok(report.split("\n").length<80);
});

test("pattern candidates require historical, cost, recent and no-lookahead evidence", () => {
  const recent = Array.from({ length: 10 }, () => ({ net: .01, candidateIds:["ema-rejection"] }));
  const base = { id:"ema-rejection", name: "ema rejection", occurrences: 30, outcomes: 20, netExpectancyAfterCosts: .01, successRate: .6 };
  assert.equal(validatePattern(base, recent).status, "insufficient evidence");
  assert.equal(validatePattern({ ...base, noLookahead: true }, recent).status, "validated");
  assert.equal(validatePattern({ ...base, id:"unrelated", noLookahead: true }, recent).status, "insufficient evidence");
  assert.equal(validatePattern({ ...base, noLookahead: true, outcomes: 19 }, recent).status, "insufficient evidence");
  assert.equal(validatePattern({ ...base, noLookahead: true, netExpectancyAfterCosts: 0 }, recent).status, "insufficient evidence");
});

test("contradictory weighted indicator vote abstains on ties", () => {
  assert.equal(resolveIndicatorVote({ rsi: 1, macd: -1 }, { rsi: 20, macd: 20 }), "abstention");
});

test("production evidence builder validates only sufficient positive closed-row history", () => {
  const rows=Array.from({length:45},(_,i)=>({close:100+i,closeTime:(i+1)*60000,ema50:99+i,ema200:98+i,long:80,short:20,hist:1,volRatio:1.2,bbUpper:200,bbLower:50}));
  const evidence=buildPatternEvidence(rows,5,.003).find(x=>x.id==="ema-alignment");
  const tagged=Array.from({length:10},()=>({net:.01,candidateIds:["ema-alignment"]}));
  assert.ok(evidence.occurrences>=30&&evidence.outcomes>=20&&evidence.netExpectancyAfterCosts>0);
  assert.equal(validatePattern(evidence,tagged).status,"validated");
  const adverse=buildPatternEvidence(rows.map((r,i)=>({...r,close:200-i})),5,.003).find(x=>x.id==="ema-alignment");
  assert.notEqual(validatePattern(adverse,tagged).status,"validated");
});


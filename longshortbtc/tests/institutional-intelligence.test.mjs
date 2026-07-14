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


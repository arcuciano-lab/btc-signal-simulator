import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("trade history renders every partial with safe text nodes",async()=>{const app=await readFile(new URL("../app.js",import.meta.url),"utf8");assert.match(app,/for \(const part of trade\.partials \|\| \[\]\)/);assert.match(app,/detail\.textContent/);assert.match(app,/part\.fraction/);assert.match(app,/part\.price/);assert.match(app,/part\.reason/);assert.match(app,/body\.replaceChildren\(\)/);assert.doesNotMatch(app,/50% partial at/);assert.match(app,/escapeHtml\(legs\)/)});

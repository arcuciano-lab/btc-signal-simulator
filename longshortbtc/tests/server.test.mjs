import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { resetServerState, server } from "../server.mjs";

const originalFetch = globalThis.fetch;
let baseUrl;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => resetServerState());

after(async () => {
  globalThis.fetch = originalFetch;
  server.close();
  await once(server, "close");
});

test("static assets return a stable ETag and support revalidation", async () => {
  const first = await originalFetch(`${baseUrl}/strategy.js`);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(first.headers.get("cache-control"), "no-cache");

  const second = await originalFetch(`${baseUrl}/strategy.js`, { headers:{ "if-none-match":etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("klines validates intervals before contacting the upstream provider", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("[]"); };
  const response = await originalFetch(`${baseUrl}/api/klines?interval=1d`);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("klines truncates decimal limits and deduplicates concurrent and cached requests", async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async url => {
    calls += 1;
    assert.match(url, /interval=5m&limit=300$/);
    await pending;
    return new Response("[[1]]", { status:200 });
  };

  const first = originalFetch(`${baseUrl}/api/klines?interval=5m&limit=300.9`);
  const second = originalFetch(`${baseUrl}/api/klines?interval=5m&limit=300.9`);
  for (let attempt = 0; calls === 0 && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(calls, 1);
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ["[[1]]", "[[1]]"]);

  const cached = await originalFetch(`${baseUrl}/api/klines?interval=5m&limit=300.9`);
  assert.equal(await cached.text(), "[[1]]");
  assert.equal(calls, 1);
});



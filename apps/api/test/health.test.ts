import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";

const webOrigin = "http://127.0.0.1:5173";

async function startApi(t: TestContext, checkDatabase: () => Promise<void>) {
  const server = createApp(webOrigin, checkDatabase).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("liveness works independently of the database", async (t) => {
  let databaseChecks = 0;
  const base = await startApi(t, async () => { databaseChecks++; });

  const response = await fetch(`${base}/api/health`, { headers: { Origin: webOrigin } });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), webOrigin);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    name: "Fiscal Floow API",
    status: "ok",
    fiscalIntegration: "not-configured",
  });
  assert.equal(databaseChecks, 0);
});

test("readiness verifies the database", async (t) => {
  let databaseChecks = 0;
  const base = await startApi(t, async () => { databaseChecks++; });

  const response = await fetch(`${base}/api/health/ready`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  assert.equal(databaseChecks, 1);
});

test("readiness returns 503 without exposing database errors", async (t) => {
  const base = await startApi(t, async () => {
    throw new Error("private database diagnostic");
  });

  const response = await fetch(`${base}/api/health/ready`);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "unavailable" });
});

test("readiness is rate limited before querying the database", async (t) => {
  let databaseChecks = 0;
  const base = await startApi(t, async () => { databaseChecks++; });

  for (let request = 0; request < 120; request++) {
    const response = await fetch(`${base}/api/health/ready`);
    assert.equal(response.status, 200);
    await response.json();
  }

  const response = await fetch(`${base}/api/health/ready`);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { status: "rate-limited" });
  assert.equal(databaseChecks, 120);
});

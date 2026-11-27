import assert from "node:assert/strict";
import { test } from "node:test";
import { certificateExpiryMessage, certificateValidity } from "../src/organizations/certificate-status.ts";

const now = Date.parse("2026-11-26T12:00:00-03:00");
const day = 86_400_000;
const expiry = (remaining: number) => new Date(now + remaining).toISOString();

test("A1 warnings begin at 30 days and become urgent at seven days", () => {
  for (const [remaining, kind, days, attention] of [
    [31 * day, "valid", 31, false], [30 * day + 1, "valid", 31, false],
    [30 * day, "expiring", 30, true], [8 * day, "expiring", 8, true],
    [7 * day + 1, "expiring", 8, true], [7 * day, "urgent", 7, true],
    [day, "urgent", 1, true], [1, "urgent", 1, true], [0, "expired", 0, true], [-day, "expired", 0, true],
  ] as const) {
    const result = certificateValidity(expiry(remaining), now);
    assert.equal(result?.kind, kind);
    assert.equal(result?.days, days);
    assert.equal(result?.needsAttention, attention);
  }
});

test("A1 countdown changes with time and respects the precise expiration instant", () => {
  const end = "2027-01-01T02:30:00Z";
  assert.equal(certificateValidity(end, Date.parse("2027-01-01T02:29:59Z"))?.kind, "urgent");
  assert.equal(certificateValidity(end, Date.parse("2027-01-01T02:30:00Z"))?.kind, "expired");
  assert.equal(certificateValidity(expiry(31 * day), now + day)?.kind, "expiring");
  assert.equal(certificateValidity("invalid", now), null);
  assert.equal(certificateValidity(expiry(day), Number.NaN), null);
  const future = certificateValidity(expiry(300 * day), now, expiry(day));
  assert.equal(future?.kind, "upcoming");
  assert.equal(future?.needsAttention, true);
  assert.match(certificateExpiryMessage(certificateValidity(expiry(0), now)!), /vencido/);
  assert.match(certificateExpiryMessage(certificateValidity(expiry(1), now)!), /24 horas/);
});

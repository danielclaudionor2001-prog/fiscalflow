import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMonthlyReference, issuancePeriod, maintenanceDescription, scheduleDescription } from "../src/invoices/schedule-description.ts";

test("monthly descriptions spell the previous month across all months and the year boundary", () => {
  const expected = ["DEZEMBRO", "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO"];
  for (let month = 1; month <= 12; month++) {
    const period = "2027-" + String(month).padStart(2, "0");
    assert.equal(scheduleDescription({ serviceDescription: maintenanceDescription, previousMonthDescription: true }, period), maintenanceDescription.replace("NOVEMBRO", expected[month - 1]));
  }
  assert.equal(scheduleDescription({ serviceDescription: maintenanceDescription, previousMonthDescription: true }, "2026-12"), maintenanceDescription);
  assert.ok(scheduleDescription({ serviceDescription: maintenanceDescription, previousMonthDescription: true }, "2028-03").includes("DO MÊS DE FEVEREIRO,"));
  assert.equal(issuancePeriod(new Date("2026-12-01T02:59:59Z")), "2026-11");
  assert.equal(issuancePeriod(new Date("2026-12-01T03:00:00Z")), "2026-12");
});

test("fixed descriptions stay unchanged and ambiguous monthly descriptions are rejected", () => {
  const fixed = { serviceDescription: maintenanceDescription, previousMonthDescription: false };
  assert.equal(scheduleDescription(fixed, "2027-01"), maintenanceDescription);
  for (const description of ["Manutenção mensal", "DO MÊS DE FOO,", "DO MÊS DE NOVEMBRO, E DO MÊS DE DEZEMBRO,"]) {
    assert.equal(hasMonthlyReference(description), false);
    assert.throws(() => scheduleDescription({ serviceDescription: description, previousMonthDescription: true }, "2027-01"), /monthly-description-invalid/);
  }
  assert.throws(() => scheduleDescription({ ...fixed, previousMonthDescription: true }, "2027-13"), /monthly-description-invalid/);
  assert.equal(hasMonthlyReference(maintenanceDescription), true);
  assert.equal(hasMonthlyReference(maintenanceDescription), true);
});

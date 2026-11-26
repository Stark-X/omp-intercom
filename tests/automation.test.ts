import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMatrix, selectReproducedFailures } from "../.github/scripts/compatibility.mjs";

const baseline = { pi: "1.0.0", omp: "19.0.0", bun: "1.4.0", intercom: "0.19.0" };
const latest = { pi: "1.1.0", omp: "19.1.0", bun: "1.4.1", intercom: "0.20.0" };

test("the matrix checks pi-intercom independently and includes the combined update", () => {
  const { include } = buildMatrix(baseline, latest);
  assert.deepEqual(include.map(({ versions }) => versions), [
    baseline,
    { ...baseline, pi: latest.pi },
    { ...baseline, omp: latest.omp, bun: latest.bun },
    { ...baseline, intercom: latest.intercom },
    latest,
  ]);
});

test("only reproduced failures on changed versions with a passing baseline trigger repair", () => {
  const matrix = buildMatrix(baseline, { ...latest, pi: baseline.pi });
  const reports = new Map(matrix.include.map(({ scenario, versions }) => [
    scenario, { versions, status: "regression" },
  ]));
  reports.get("baseline")!.status = "pass";
  reports.get("latest-omp")!.status = "unconfirmed";
  reports.get("latest-all")!.versions = baseline;

  const diagnosis = selectReproducedFailures(matrix, scenario => reports.get(scenario));
  assert.deepEqual(diagnosis.failures.map(({ scenario }) => scenario), ["latest-pi-intercom"]);
  assert.equal(diagnosis.reports.find(({ scenario }) => scenario === "latest-all")?.status, "infrastructure");

  reports.delete("baseline");
  assert.deepEqual(selectReproducedFailures(matrix, scenario => reports.get(scenario)).failures, []);
});

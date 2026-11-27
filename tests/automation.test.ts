import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMatrix, selectReproducedFailures } from "../.github/scripts/compatibility.mjs";
import { repairConfig } from "../.github/scripts/repair-provider.mjs";

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

const gateway = {
  REPAIR_BASE_URL: "https://gateway.example.test/proxy/v1/",
  REPAIR_MODEL: "provider/model:free",
  REPAIR_API_KEY: "fixture-key",
};

test("repair model IDs and endpoint prefixes are preserved across API protocols", () => {
  for (const [api, providerPackage] of [
    [undefined, "@ai-sdk/openai-compatible"],
    ["responses", "@ai-sdk/openai"],
    ["anthropic-messages", "@ai-sdk/anthropic"],
  ]) {
    const config = repairConfig({ ...gateway, REPAIR_API: api });
    assert.equal(config.model, "repair-provider/provider/model:free");
    assert.deepEqual(config.enabled_providers, ["repair-provider"]);
    const provider = config.provider["repair-provider"];
    assert.equal(provider.npm, providerPackage);
    assert.equal(provider.options.baseURL, "https://gateway.example.test/proxy/v1");
    assert.equal(provider.options.apiKey, "{env:REPAIR_API_KEY}");
    assert.ok(!JSON.stringify(config).includes(gateway.REPAIR_API_KEY));
  }
});

test("repair configuration rejects missing credentials and full request endpoints", () => {
  assert.throws(() => repairConfig({ ...gateway, REPAIR_API_KEY: "" }), /REPAIR_API_KEY/);
  assert.throws(() => repairConfig({ ...gateway, REPAIR_API: "unknown" }), /REPAIR_API/);
  for (const suffix of ["chat/completions", "responses", "messages"]) {
    assert.throws(() => repairConfig({
      ...gateway, REPAIR_BASE_URL: `${gateway.REPAIR_BASE_URL}${suffix}`,
    }), /API prefix/);
  }
});

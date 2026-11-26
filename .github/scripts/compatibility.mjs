import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packages = {
  pi: "@earendil-works/pi-coding-agent",
  omp: "@oh-my-pi/pi-coding-agent",
  bun: "bun",
  intercom: "pi-intercom",
};

const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const pinned = JSON.parse(readFileSync(new URL("../compatibility-versions.json", import.meta.url)));

export function buildMatrix(baseline, latest) {
  return {
    include: [
      { scenario: "baseline", versions: baseline },
      { scenario: "latest-pi", versions: { ...baseline, pi: latest.pi } },
      { scenario: "latest-omp", versions: { ...baseline, omp: latest.omp, bun: latest.bun } },
      { scenario: "latest-pi-intercom", versions: { ...baseline, intercom: latest.intercom } },
      { scenario: "latest-all", versions: latest },
    ],
  };
}

function validVersions(versions) {
  return versions && Object.keys(packages).every(key =>
    typeof versions[key] === "string" && versionPattern.test(versions[key]));
}

export function selectReproducedFailures(matrix, readReport) {
  const reports = matrix.include.map(({ scenario, versions }) => {
    const report = readReport(scenario);
    if (!validVersions(report?.versions) ||
        !Object.keys(packages).every(key => report.versions[key] === versions[key]) ||
        !["pass", "regression", "infrastructure", "unconfirmed"].includes(report.status)) {
      return { scenario, versions, status: "infrastructure" };
    }
    return { scenario, versions, status: report.status,
      diagnostic: String(report.diagnostic ?? "").slice(0, 1000) };
  });
  const baseline = reports.find(report => report.scenario === "baseline");
  const reproduced = reports.filter(report => report.scenario !== "baseline" &&
    report.status === "regression" &&
    Object.keys(packages).some(key => report.versions[key] !== baseline?.versions[key]));
  return { reports, failures: baseline?.status === "pass" ? reproduced : [] };
}

function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${JSON.stringify(value)}\n`);
}

function npmLatest(packageName) {
  return JSON.parse(execFileSync("npm", ["view", `${packageName}@latest`, "version", "--json"], {
    encoding: "utf8",
    timeout: 45_000,
  }));
}

function main(command) {
  if (command === "resolve") {
    const latest = Object.fromEntries(Object.entries(packages).map(([key, name]) => [key, npmLatest(name)]));
    if (!validVersions(pinned) || !validVersions(latest)) throw new Error("Invalid compatibility version");
    const matrix = buildMatrix(pinned, latest);
    console.log(JSON.stringify(matrix, null, 2));
    output("matrix", matrix);
    return;
  }

  if (command === "install-args") {
    const versions = process.env.HARNESS_VERSIONS ? JSON.parse(process.env.HARNESS_VERSIONS) : pinned;
    if (!validVersions(versions)) throw new Error("Invalid harness versions");
    console.log(Object.entries(packages).map(([key, name]) => `${name}@${versions[key]}`).join("\n"));
    return;
  }

  if (command === "diagnose") {
    const directories = readdirSync(process.env.REPORTS_DIR);
    const { reports, failures } = selectReproducedFailures(JSON.parse(process.env.COMPATIBILITY_MATRIX), scenario => {
      const prefix = `report-${scenario}-attempt-`;
      const attempts = directories
        .filter(directory => directory.startsWith(prefix) && /^\d+$/.test(directory.slice(prefix.length)))
        .sort((left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)));
      if (!attempts.length) return null;
      try {
        return JSON.parse(readFileSync(join(process.env.REPORTS_DIR, attempts[0], "report.json"), "utf8"));
      } catch {
        return null;
      }
    });
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "## Compatibility results",
      "",
      "| Scenario | Pi | OMP | Bun | pi-intercom | Result |",
      "| --- | --- | --- | --- | --- | --- |",
      ...reports.map(({ scenario, versions, status }) =>
        `| ${scenario} | ${versions.pi} | ${versions.omp} | ${versions.bun} | ${versions.intercom} | ${status} |`),
      "",
      failures.length
        ? "The baseline passed and a changed version combination failed twice."
        : "There is no confirmed upstream regression with a passing baseline.",
      "",
    ].join("\n"));
    writeFileSync(join(process.env.RUNNER_TEMP, "compatibility-evidence.json"), JSON.stringify(failures, null, 2));
    output("repair", failures.length > 0);
    return;
  }

  throw new Error(`Unknown compatibility command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]);
}

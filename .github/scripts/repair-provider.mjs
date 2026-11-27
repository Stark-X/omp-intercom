import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const providerPackages = new Map([
  ["chat-completions", "@ai-sdk/openai-compatible"],
  ["responses", "@ai-sdk/openai"],
  ["anthropic-messages", "@ai-sdk/anthropic"],
]);

export function repairConfig(env) {
  const base = env.REPAIR_BASE_URL?.trim();
  const model = env.REPAIR_MODEL?.trim();
  const api = env.REPAIR_API?.trim() || "chat-completions";
  const providerPackage = providerPackages.get(api);

  if (!base || !model || !env.REPAIR_API_KEY?.trim()) {
    throw new Error("Set REPAIR_BASE_URL and REPAIR_MODEL as Actions variables and REPAIR_API_KEY as an Actions secret.");
  }
  if (!providerPackage) {
    throw new Error("REPAIR_API must be chat-completions, responses, or anthropic-messages.");
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("REPAIR_BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("REPAIR_BASE_URL must be an HTTP(S) API prefix without credentials, query parameters or a fragment.");
  }
  const baseURL = url.href.replace(/\/+$/, "");
  if (/\/(chat\/completions|responses|messages)$/.test(baseURL)) {
    throw new Error("Set REPAIR_BASE_URL to the API prefix, with the /chat/completions, /responses or /messages suffix removed.");
  }

  return {
    model: `repair-provider/${model}`,
    enabled_providers: ["repair-provider"],
    autoupdate: false,
    formatter: false,
    lsp: false,
    share: "disabled",
    provider: {
      "repair-provider": {
        name: "Repair model provider",
        npm: providerPackage,
        options: { baseURL, apiKey: "{env:REPAIR_API_KEY}" },
        models: {
          [model]: { name: model, tool_call: true, limit: { context: 32768, output: 8192 } },
        },
      },
    },
    agent: {
      title: { disable: true },
      "compatibility-repair": {
        mode: "primary",
        permission: {
          "*": "deny",
          external_directory: "deny",
          read: { "*": "allow", ".git": "deny", ".git/**": "deny", "**/.env*": "deny" },
          glob: "allow",
          grep: "allow",
          edit: {
            "*": "deny",
            "src/**": "allow",
            "skills/**": "allow",
            "README.md": "allow",
            "THIRD_PARTY_NOTICES.md": "allow",
          },
        },
      },
    },
  };
}

function runRepair(binary, promptFile) {
  const config = repairConfig(process.env);
  const prompt = readFileSync(promptFile, "utf8");
  const worktree = process.cwd();
  const state = mkdtempSync(join(process.env.RUNNER_TEMP, "repair-agent-"));
  try {
    const result = spawnSync(binary, [
      "run", "--dir", worktree, "--agent", "compatibility-repair", "--model", config.model, "--format", "json",
    ], {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 18 * 60 * 1000,
      env: {
        ...process.env,
        PWD: worktree,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_PLUGINS: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        XDG_CONFIG_HOME: join(state, "config"),
        XDG_DATA_HOME: join(state, "data"),
        XDG_CACHE_HOME: join(state, "cache"),
        XDG_STATE_HOME: join(state, "state"),
      },
    });
    if (result.error) {
      throw new Error(`The repair agent could not run (${result.error.code ?? "unknown process error"}).`);
    }
    const events = (result.stdout ?? "").split("\n").flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const error = events.find(event => event.type === "error");
    const terminal = events.findLast(event => event.type === "step_finish");
    if (result.status !== 0 || error || !terminal || terminal.part?.reason !== "stop") {
      const status = error?.error?.data?.statusCode;
      const details = Number.isInteger(status) ? ` (HTTP ${status})` : "";
      throw new Error(`The repair agent did not complete${details}. Check the provider endpoint, model ID, API key and tool support.`);
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRepair(process.argv[2], process.argv[3]);
}

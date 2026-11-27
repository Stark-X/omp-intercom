import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerIntercomCommands } from "./adapter/commands.ts";
import { IntercomSession } from "./adapter/session.ts";
import { registerIntercomTool } from "./adapter/tools.ts";
import { createTranslator } from "./i18n/index.ts";
import { getAskTimeoutMs, loadConfig } from "./vendor/pi-intercom/config.ts";

export default function intercom(pi: ExtensionAPI) {
  const config = loadConfig(join(getAgentDir(), "intercom", "config.json"));
  if (!config.enabled) return;

  const askTimeoutMs = getAskTimeoutMs();
  const piAgentDir = process.env.OMP_INTERCOM_PI_AGENT_DIR?.trim();
  const brokerEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: piAgentDir ? resolve(piAgentDir) : join(homedir(), ".pi", "agent"),
  };

  let session: IntercomSession | undefined;
  let shutdown = Promise.resolve();
  // Ask IDs map to their scoped broker identities, which can survive an OMP session switch.
  const pendingAskCancellations = new Map<string, string>();

  function stopSession() {
    const previous = session;
    session = undefined;
    if (previous) shutdown = previous.stop();
    return shutdown;
  }

  function startSession(ctx: ExtensionContext) {
    const previousShutdown = stopSession();
    session = new IntercomSession(pi, ctx, config, brokerEnv, askTimeoutMs, previousShutdown, pendingAskCancellations);
    session.start();
  }

  registerIntercomTool(pi, () => session);
  registerIntercomCommands(pi, () => session, createTranslator());
  pi.on("session_start", (_event, ctx) => startSession(ctx));
  pi.on("session_switch", (_event, ctx) => startSession(ctx));
  pi.on("session_clear", (_event, ctx) => startSession(ctx));
  pi.on("session_shutdown", stopSession);
  pi.on("agent_start", () => session?.refreshPresence());
  pi.on("agent_end", () => session?.refreshPresence());
}

import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Translate } from "../i18n/index.ts";
import { listMachineAgents, listSavedMachines, parseCrossMachineTarget } from "../vendor/pi-intercom/cross-machine-discovery.ts";
import { runCommand, sendCrossMachine } from "../vendor/pi-intercom/cross-machine-transport.ts";
import { currentHerdrHost, openHerdrAppPane, resolveTargetInCwd, waitForProjectSession } from "../vendor/pi-intercom/project-agent.ts";
import type { SessionInfo } from "../vendor/pi-intercom/types.ts";
import { generateHandover } from "./handover.ts";
import { resolveAskTarget, sessionLabel } from "./messaging.ts";
import type { IntercomSession } from "./session.ts";
import { pick, sessionItem, showProgress, type PickerItem } from "./terminal.ts";

type HandoverTarget = { kind: "local"; peer: SessionInfo } | { kind: "project"; cwd: string } | { kind: "remote"; address: string };

function requireTerminal(ctx: ExtensionContext, command: string, t: Translate): void {
  if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(t("terminalRequired", { command }));
}

function peerSessions(sessions: SessionInfo[], ownId: string): SessionInfo[] {
  return sessions.filter(peer => peer.id !== ownId && peer.model !== "pi-intercom-cli")
    .sort((left, right) => right.lastActivity - left.lastActivity || left.id.localeCompare(right.id));
}

function projectPath(cwd: string, path: string): string {
  return resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}

function remoteDiscovery() {
  return { run: runCommand, herdrBin: process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || "herdr" };
}

async function chooseRemote(ctx: ExtensionContext, session: IntercomSession, t: Translate): Promise<HandoverTarget | undefined> {
  const discovery = remoteDiscovery();
  const discovered = await showProgress(ctx, t, session.signal, t("fetchingRemote"), async signal => {
    const machines = await listSavedMachines(discovery);
    signal.throwIfAborted();
    return Promise.allSettled(machines.filter(machine => machine.enabled).map(async machine =>
      (await listMachineAgents(machine, discovery)).map((agent): PickerItem<string> => ({
        value: `${agent.sessionId ?? agent.name}@${machine.label}`,
        label: `${agent.name}@${machine.label}`,
        detail: [agent.sessionId?.slice(0, 8), agent.cwd, agent.status].filter(Boolean).join(" · "),
      })),
    ));
  });
  if (!discovered) return;
  const options: PickerItem<string>[] = [];
  for (const result of discovered) {
    if (result.status === "fulfilled") options.push(...result.value);
    else {
      const error = result.reason;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  }
  if (!options.length) {
    ctx.ui.notify(t("noRemoteSessions"), "info");
    return;
  }
  const picked = await pick(ctx, t, { title: t("remoteSessions"), items: options, action: t("select"), signal: session.signal });
  if (picked) return { kind: "remote", address: picked.value };
}

async function chooseHandoverTarget(ctx: ExtensionContext, session: IntercomSession, t: Translate, selectedId?: string): Promise<HandoverTarget | undefined> {
  const client = await session.connect();
  const peers = peerSessions(await client.listSessions(), session.id).filter(peer => !peer.id.startsWith("subagent-"));
  session.signal.throwIfAborted();
  const items: PickerItem<SessionInfo | "project" | "remote">[] = peers.map(peer => sessionItem(peer, t));
  items.push(
    { label: t("newProject"), value: "project" },
    { label: t("fetchRemote"), value: "remote" },
  );
  const picked = await pick(ctx, t, {
    title: t("chooseHandover"), items, action: t("select"), initialIndex: peers.findIndex(peer => peer.id === selectedId), signal: session.signal,
  });
  if (!picked) return;
  if (picked.value === "remote") return chooseRemote(ctx, session, t);
  if (picked.value === "project") {
    const path = (await ctx.ui.input(t("projectPath"), "~/dev/project", { signal: session.signal }))?.trim();
    if (path) return { kind: "project", cwd: projectPath(ctx.cwd, path) };
    return;
  }
  return { kind: "local", peer: picked.value };
}

async function resolveHandoverTarget(ctx: ExtensionContext, session: IntercomSession, address: string, t: Translate): Promise<HandoverTarget> {
  if (/^(\/|\.\.?\/|~(\/|$))/.test(address)) return { kind: "project", cwd: projectPath(ctx.cwd, address) };
  if (address.includes("@")) {
    parseCrossMachineTarget(address);
    return { kind: "remote", address };
  }
  const client = await session.connect();
  const peer = resolveAskTarget(await client.listSessions(), address, t);
  if (peer.id === session.id) throw new Error(t("handoverSelf"));
  return { kind: "local", peer };
}

function targetLabel(target: HandoverTarget): string {
  if (target.kind === "local") return sessionLabel(target.peer);
  if (target.kind === "project") return target.cwd;
  return target.address;
}

async function resolveProjectPeer(ctx: ExtensionContext, session: IntercomSession, cwd: string, signal: AbortSignal, t: Translate): Promise<SessionInfo> {
  const client = await session.connect();
  const sessions = await client.listSessions();
  const existing = resolveTargetInCwd({ sessions: peerSessions(sessions, session.id), currentSessionId: session.id, targetCwd: cwd });
  if (existing.session) return existing.session;

  const host = currentHerdrHost();
  if (!host) throw new Error(t("projectUnavailable", { cwd }));
  const command: [string, ...string[]] = [
    "/usr/bin/env", `PI_INTERCOM_SCOPE_ID=${session.pool ?? ""}`, `OMP_INTERCOM_PI_AGENT_DIR=${session.brokerAgentDir ?? ""}`,
    "OMP_INTERCOM_STABLE_ID=", "OMP_INTERCOM_NAME=", "omp", "-e", fileURLToPath(new URL("../../", import.meta.url)),
  ];
  signal.throwIfAborted();
  if (host.kind === "app") {
    await openHerdrAppPane({ cwd, terminalId: host.terminalId, placement: session.config.herdr.projectPlacement, argv: command, signal });
  } else {
    if (!ctx.ui.openTerminal) throw new Error(t("projectPaneUnavailable"));
    await ctx.ui.openTerminal({ multiplexer: "herdr", placement: "pane", target: host.paneId, direction: "right", cwd, command });
  }
  return waitForProjectSession(client, {
    projectRoot: cwd, currentSessionId: session.id, beforeSessionIds: new Set(sessions.map(peer => peer.id)), signal, agentName: "OMP",
  });
}

async function sendLocal(pi: ExtensionAPI, ctx: ExtensionContext, session: IntercomSession, peer: SessionInfo, text: string, t: Translate): Promise<void> {
  const client = await session.connect();
  const label = sessionLabel(peer);
  const current = (await client.listSessions()).find(entry => entry.id === peer.id);
  if (!current || (peer.endpointEpoch && peer.endpointEpoch !== current.endpointEpoch)) {
    throw new Error(t("stalePeer", { peer: label }));
  }
  session.signal.throwIfAborted();
  const result = await client.send(peer.id, { text, targetEpoch: current.endpointEpoch, signal: session.signal });
  if (!result.delivered) throw new Error(t("deliveryError", { peer: label, error: result.reason ?? result.delivery }));
  if (session.signal.aborted) return;
  pi.appendEntry("intercom_sent", { to: label, message: { text }, messageId: result.id, timestamp: Date.now() });
  ctx.ui.notify(t(result.delivery === "queued" ? "queuedForPeer" : "sentToPeer", { peer: label }), "info");
}

async function performHandover(
  pi: ExtensionAPI, ctx: ExtensionContext, session: IntercomSession, target: HandoverTarget, t: Translate, goal?: string,
): Promise<void> {
  const label = targetLabel(target);
  const summary = await showProgress(ctx, t, session.signal, t("generating"), signal =>
    generateHandover(ctx, session.status().name, goal, target.kind === "remote", signal, t));
  if (!summary) return;
  const text = await ctx.ui.editor(t("reviewHandover", { peer: label }), summary, { signal: session.signal });
  if (!text?.trim()) return;
  if (session.config.confirmSend && !await ctx.ui.confirm(t("sendHandover"), t("sendToPeer", { peer: label }), { signal: session.signal })) return;
  session.signal.throwIfAborted();

  if (target.kind === "remote") {
    const { agent, machine } = await sendCrossMachine(target.address, text, {
      name: session.status().name, sessionId: session.id, machine: session.config.crossMachine.machineName,
    }, { ...remoteDiscovery(), remoteCommand: session.config.crossMachine.remoteCommand });
    if (session.signal.aborted) return;
    const to = `${agent.name}@${machine.label}`;
    pi.appendEntry("intercom_sent", { to, message: { text }, timestamp: Date.now(), crossMachine: true });
    ctx.ui.notify(t("sentRemote", { peer: to }), "info");
    return;
  }

  const peer = target.kind === "local" ? target.peer : await showProgress(ctx, t, session.signal, t("connectingProject"), signal =>
    resolveProjectPeer(ctx, session, target.cwd, signal, t));
  if (peer) await sendLocal(pi, ctx, session, peer, text, t);
}

async function handoverFromPicker(pi: ExtensionAPI, ctx: ExtensionContext, session: IntercomSession, t: Translate, selectedId?: string): Promise<void> {
  const target = await chooseHandoverTarget(ctx, session, t, selectedId);
  if (!target) return;
  await handoverWithGoal(pi, ctx, session, target, t);
}

async function handoverWithGoal(pi: ExtensionAPI, ctx: ExtensionContext, session: IntercomSession, target: HandoverTarget, t: Translate) {
  const goal = await ctx.ui.input(t("nextTaskField"), undefined, { signal: session.signal });
  if (goal !== undefined) await performHandover(pi, ctx, session, target, t, goal.trim());
}

export function registerIntercomCommands(pi: ExtensionAPI, currentSession: () => IntercomSession | undefined, t: Translate): void {
  const running = new WeakSet<IntercomSession>();
  const command = (run: (args: string, ctx: ExtensionContext, session: IntercomSession) => Promise<void>) =>
    async (args: string, ctx: ExtensionContext) => {
      const session = currentSession();
      if (!session || session.hostId !== ctx.sessionManager.getSessionId() || session.signal.aborted || running.has(session)) return;
      running.add(session);
      try {
        await run(args.trim(), ctx, session);
      } catch (error) {
        if (!session.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        running.delete(session);
      }
    };

  const intercom = command(async (_args, ctx, session) => {
    requireTerminal(ctx, "/intercom", t);
    const client = await session.connect();
    const items = peerSessions(await client.listSessions(), session.id).map(peer => sessionItem(peer, t));
    session.signal.throwIfAborted();
    const picked = await pick(ctx, t, {
      title: t("intercomTitle", { name: session.status().name, pool: session.pool ?? t("defaultPool") }),
      items, action: t("compose"), handoverKey: true, signal: session.signal,
    });
    if (!picked) return;
    if (picked.action === "handover") {
      await handoverFromPicker(pi, ctx, session, t, picked.value.id);
      return;
    }
    if (picked.action === "next-task") {
      await handoverWithGoal(pi, ctx, session, { kind: "local", peer: picked.value }, t);
      return;
    }
    const label = sessionLabel(picked.value);
    const text = await ctx.ui.editor(t("messageTo", { peer: label }), undefined, { signal: session.signal }, { promptStyle: true });
    if (!text?.trim()) return;
    if (session.config.confirmSend && !await ctx.ui.confirm(t("confirmMessage"), t("sendToPeer", { peer: label }), { signal: session.signal })) return;
    await sendLocal(pi, ctx, session, picked.value, text, t);
  });
  pi.registerCommand("intercom", { description: t("commandIntercom"), handler: intercom });
  pi.registerShortcut("alt+shift+m", { description: t("commandIntercom"), handler: ctx => intercom("", ctx) });

  pi.registerCommand("handover", {
    description: t("commandHandover"),
    handler: command(async (args, ctx, session) => {
      requireTerminal(ctx, "/handover", t);
      if (args) {
        const parsed = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/.exec(args);
        const address = parsed?.[1] ?? parsed?.[2] ?? parsed?.[3];
        if (!address || /^["']/.test(address)) throw new Error(t("handoverUsage"));
        const target = await resolveHandoverTarget(ctx, session, address, t);
        await performHandover(pi, ctx, session, target, t, parsed?.[4]);
        return;
      }
      await handoverFromPicker(pi, ctx, session, t);
    }),
  });

  pi.registerCommand("intercom-id", {
    description: t("commandId"),
    handler: command(async (_args, ctx, session) => {
      await session.connect();
      session.signal.throwIfAborted();
      if (ctx.hasUI && ctx.ui.supportsEditor) {
        const snippet = t("useContact", { example: `intercom({ action: "send", to: ${JSON.stringify(session.id)}, message: "…" })` });
        const draft = ctx.ui.getEditorText().trimEnd();
        ctx.ui.setEditorText(draft ? `${draft}\n\n${snippet}` : snippet);
      }
      ctx.ui.notify(t("contactTarget", { id: session.id }), "info");
    }),
  });

  pi.registerCommand("intercom-pool", {
    description: t("commandPool"),
    handler: command(async (args, ctx, session) => {
      if (!args) {
        ctx.ui.notify(t("activePool", { pool: session.pool ?? t("defaultPool") }), "info");
        return;
      }
      await session.switchPool(args === "default" ? undefined : args, t);
      if (!session.signal.aborted) ctx.ui.notify(t("joinedPool", { pool: session.pool ?? t("defaultPool") }), "info");
    }),
  });

  pi.registerCommand("alias", {
    description: t("commandAlias"),
    handler: command(async (args, ctx, session) => {
      const alias = !args || args.toLowerCase() === "menu"
        ? (await ctx.ui.input(t("aliasTitle"), session.status().name, { signal: session.signal }))?.trim()
        : args;
      if (alias === undefined) return;
      if (!alias) throw new Error(t("aliasEmpty"));
      await session.setAlias(alias);
      ctx.ui.notify(t("aliasSet", { alias }), "info");
    }),
  });
}

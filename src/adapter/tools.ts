import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SendResult } from "../vendor/pi-intercom/broker/client.ts";
import { messageBody, resolveAskTarget, sessionLabel } from "./messaging.ts";
import type { IntercomSession } from "./session.ts";

function output(text: string, details: object = {}, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

function reportDelivery(target: string, result: SendResult, replyTo?: string) {
  let text: string;
  if (!result.delivered) {
    text = `Delivery to ${target} failed: ${result.reason ?? result.delivery}`;
  } else if (result.demoted) {
    text = `Delivered to ${target} as a new message because the ask had closed.`;
  } else {
    text = result.delivery === "queued" ? `Queued for ${target}.` : `Delivered to ${target}.`;
  }
  return output(`${text} Message ID: ${result.id}`, { ...result, replyTo }, !result.delivered);
}

export function registerIntercomTool(pi: ExtensionAPI, currentSession: () => IntercomSession | undefined) {
  const z = pi.zod;
  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: "Discover local Pi and OMP peers, send messages, ask and wait for a reply, answer incoming asks, or check session status.",
    loadMode: "essential",
    parameters: z.object({
      action: z.enum(["list", "send", "ask", "reply", "status"]),
      to: z.string().optional().describe("Peer name, full session ID, or unique ID prefix"),
      message: z.string().optional().describe("Message or reply text"),
      replyTo: z.string().optional().describe("For reply, the inbound ask's message ID"),
      noWake: z.boolean().optional().describe("For send, deliver without waking an idle recipient"),
    }),
    async execute(_callId, args, signal, _onUpdate, ctx) {
      const session = currentSession();
      if (!session || session.hostId !== ctx.sessionManager.getSessionId()) {
        return output("Intercom is unavailable for this session.", {}, true);
      }

      try {
        if (args.action === "status") {
          const status = session.status();
          const pending = status.pendingAsks.map(ask => `- ${ask.from} (${ask.fromId}), replyTo ${ask.messageId}`);
          return output([
            `${status.name} (${status.id}): ${status.connection}, ${status.status}`,
            ...(status.lastError ? [status.lastError] : []),
            ...(pending.length ? ["Pending asks", ...pending] : ["No pending asks."]),
          ].join("\n"), status);
        }

        const to = args.to?.trim() || undefined;
        const replyTo = args.replyTo?.trim() || undefined;
        if (args.action !== "list" && !args.message?.trim()) throw new Error("A message is required");
        if ((args.action === "send" || args.action === "ask") && !to) {
          throw new Error("A recipient is required. Use list to find a peer.");
        }
        signal?.throwIfAborted();
        const client = await session.connect();
        signal?.throwIfAborted();

        if (args.action === "list") {
          const peers = (await client.listSessions()).filter(peer => peer.id !== session.id);
          const lines = peers.map(peer => `- ${sessionLabel(peer)} (${peer.id}) | ${peer.status ?? "online"} | ${peer.cwd}`);
          return output(lines.length ? lines.join("\n") : "No other Intercom sessions are connected.", { sessions: peers });
        }

        const message = args.message!;
        if (args.action === "reply") {
          const reply = await session.messaging.reply(client, message, { to, replyTo }, signal);
          return reportDelivery(sessionLabel(reply.from), reply.result, reply.message.id);
        }

        if (session.config.confirmSend && ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(`Intercom ${args.action}`, `Send to ${to}?\n\n${message}`);
          if (!confirmed) return output("Intercom send declined.", {}, true);
        }
        signal?.throwIfAborted();
        if (args.action === "send") {
          return reportDelivery(to!, await client.send(to!, { text: message, noWake: args.noWake, signal }));
        }

        const target = resolveAskTarget(await client.listSessions(), to!);
        if (target.id === session.id) throw new Error("Cannot ask the current session");
        const answer = await session.messaging.ask(client, target, message, signal);
        return output(`Reply from ${sessionLabel(target)}:\n\n${messageBody(answer.message)}`, {
          from: target,
          messageId: answer.id,
          reply: answer.message,
        });
      } catch (error) {
        return output(error instanceof Error ? error.message : String(error), {}, true);
      }
    },
  });
}

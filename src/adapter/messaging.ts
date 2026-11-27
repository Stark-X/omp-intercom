import { randomUUID } from "node:crypto";
import { english, type Translate } from "../i18n/index.ts";
import type { IntercomClient } from "../vendor/pi-intercom/broker/client.ts";
import { ReplyTracker } from "../vendor/pi-intercom/reply-tracker.ts";
import type { Message, SessionInfo } from "../vendor/pi-intercom/types.ts";

interface ReplyWaiter {
  senderId: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
}

const MAX_SEEN_MESSAGES = 4096;
const CANCELLATION_BATCH_SIZE = 32;

export function sessionLabel(session: SessionInfo): string {
  return session.name || session.id;
}

export function messageBody(message: Message): string {
  const attachments = message.content.attachments?.map(
    attachment => `[${attachment.type} attachment: ${attachment.name}]\n${attachment.content}`,
  ) ?? [];
  return [message.content.text, ...attachments].join("\n\n");
}

export class Messaging {
  readonly tracker: ReplyTracker;
  private readonly waiters = new Map<string, ReplyWaiter>();
  private readonly seen = new Set<string>();
  private readonly replying = new Set<string>();
  private closedError?: Error;

  constructor(
    private readonly askTimeoutMs: number,
    private readonly cancellationOwner: string,
    private readonly pendingAskCancellations = new Map<string, string>(),
  ) {
    this.tracker = new ReplyTracker(askTimeoutMs);
  }

  accept(from: SessionInfo, message: Message): "duplicate" | "reply" | "inbound" {
    const key = JSON.stringify([from.id, message.id]);
    if (this.seen.has(key)) return "duplicate";
    if (this.seen.size >= MAX_SEEN_MESSAGES) this.seen.delete(this.seen.values().next().value!);
    this.seen.add(key);

    const waiter = message.replyTo ? this.waiters.get(message.replyTo) : undefined;
    if (waiter?.senderId === from.id) {
      waiter.resolve(message);
      return "reply";
    }

    if (message.expectsReply) this.tracker.recordIncomingMessage(from, message);
    return "inbound";
  }

  rejectOutboundAsks(error: Error): void {
    for (const [id, waiter] of this.waiters) {
      this.pendingAskCancellations.set(id, this.cancellationOwner);
      waiter.reject(error);
    }
  }

  get hasOutboundAsks(): boolean {
    return this.waiters.size > 0;
  }

  close(error: Error): void {
    this.closedError = error;
    this.rejectOutboundAsks(error);
    this.tracker.reset();
  }

  async cancelAbandonedAsks(client: Pick<IntercomClient, "cancelAsk" | "listSessions">): Promise<void> {
    const pending = Array.from(this.pendingAskCancellations)
      .filter(([, owner]) => owner === this.cancellationOwner)
      .map(([id]) => id);
    for (let offset = 0; offset < pending.length; offset += CANCELLATION_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + CANCELLATION_BATCH_SIZE);
      for (const id of batch) client.cancelAsk(id);
      // The broker processes frames in order. Its list reply confirms it processed preceding cancellations.
      await client.listSessions();
      for (const id of batch) this.pendingAskCancellations.delete(id);
    }
  }

  async ask(client: Pick<IntercomClient, "send" | "cancelAsk" | "isConnected">, target: SessionInfo, text: string, signal?: AbortSignal) {
    if (this.closedError) throw this.closedError;
    signal?.throwIfAborted();
    const id = randomUUID();
    const controller = new AbortController();
    const reply = new Promise<Message>((resolve, reject) => {
      this.waiters.set(id, {
        senderId: target.id,
        resolve,
        reject(error) {
          reject(error);
          controller.abort();
        },
      });
    });
    const abort = () => this.waiters.get(id)?.reject(new Error("Intercom ask cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      this.waiters.get(id)?.reject(new Error(`No reply from ${sessionLabel(target)} within ${this.askTimeoutMs} ms (ask ${id})`));
    }, this.askTimeoutMs);

    let completed = false;
    try {
      const delivery = client.send(target.id, {
        text,
        expectsReply: true,
        messageId: id,
        signal: controller.signal,
      }).then(result => {
        if (!result.delivered || result.delivery === "queued") {
          throw new Error(result.reason ?? `Could not deliver ask to ${sessionLabel(target)}`);
        }
      });
      const [, message] = await Promise.all([delivery, reply]);
      completed = true;
      return { id, message };
    } finally {
      this.waiters.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!completed) {
        controller.abort();
        if (!this.pendingAskCancellations.has(id)) {
          if (client.isConnected()) {
            client.cancelAsk(id);
          } else {
            this.pendingAskCancellations.set(id, this.cancellationOwner);
          }
        }
      }
    }
  }

  async reply(client: Pick<IntercomClient, "send">, text: string, options: { to?: string; replyTo?: string }, signal?: AbortSignal) {
    const { from, message } = this.tracker.resolveReplyTarget(options);
    if (this.replying.has(message.id)) throw new Error(`A reply to ${message.id} is already being sent`);
    this.replying.add(message.id);
    try {
      const result = await client.send(from.id, { text, replyTo: message.id, signal });
      if (result.delivered || result.code === "E_REPLY_TARGET") this.tracker.dismissPendingAsk(message.id);
      return { from, message, result };
    } finally {
      this.replying.delete(message.id);
    }
  }
}

export function resolveAskTarget(sessions: SessionInfo[], to: string, t: Translate = english): SessionInfo {
  const exactId = sessions.find(session => session.id === to);
  if (exactId) return exactId;
  const named = sessions.filter(session => session.name?.toLowerCase() === to.toLowerCase());
  const matches = named.length ? named : sessions.filter(session => session.id.startsWith(to));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(t("ambiguousPeer", { target: to }));
  throw new Error(t("missingPeer", { target: to }));
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { Messaging, resolveAskTarget } from "../src/adapter/messaging.ts";
import type { IntercomClient, SendResult } from "../src/vendor/pi-intercom/broker/client.ts";
import type { Message, SessionInfo } from "../src/vendor/pi-intercom/types.ts";

const peer: SessionInfo = {
  id: "peer-session",
  name: "Backend",
  cwd: "/backend",
  model: "fixture",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
};

const delivered: SendResult = {
  id: "message-id",
  delivered: true,
  delivery: "socket_delivered",
  retryable: false,
  outcomeKnown: true,
};

const sessionId = "local-session";

function inbound(id: string, options: Partial<Message> = {}): Message {
  return { id, timestamp: Date.now(), content: { text: "fixture" }, ...options };
}

type Outbound = Parameters<Messaging["ask"]>[0];

test("matches an early reply from the addressed peer and suppresses duplicates", async () => {
  const messaging = new Messaging(1000, sessionId);
  const client: Outbound = {
    async send(to, options) {
      assert.equal(to, peer.id);
      assert.equal(options.expectsReply, true);
      const answer = inbound("reply-id", { replyTo: options.messageId });
      assert.equal(messaging.accept({ ...peer, id: "other-session" }, answer), "inbound");
      assert.equal(messaging.accept(peer, answer), "reply");
      assert.equal(messaging.accept(peer, answer), "duplicate");
      return { ...delivered, id: options.messageId! };
    },
    cancelAsk() {
      assert.fail("Successful asks should stay completed");
    },
    isConnected: () => true,
  };
  const result = await messaging.ask(client, peer, "question");
  assert.equal(result.message.replyTo, result.id);
  assert.equal(result.message.id, "reply-id");
});

test("aborting an ask cancels its broker edge and releases the waiter", async () => {
  const messaging = new Messaging(1000, sessionId);
  const abort = new AbortController();
  let askId: string | undefined;
  let sendSignal: AbortSignal | undefined;
  const client: Outbound = {
    async send(_to, options) {
      askId = options.messageId;
      sendSignal = options.signal;
      return delivered;
    },
    cancelAsk(id) {
      assert.equal(id, askId);
    },
    isConnected: () => true,
  };
  const asking = messaging.ask(client, peer, "question", abort.signal);
  abort.abort();
  await assert.rejects(asking, /cancelled/);
  assert.equal(sendSignal?.aborted, true);
  assert.equal(messaging.accept(peer, inbound("late", { replyTo: askId })), "inbound");
});

test("retries an abandoned ask cancellation when reconnecting is interrupted", async () => {
  const pendingAskCancellations = new Map<string, string>();
  const messaging = new Messaging(1000, sessionId, pendingAskCancellations);
  const abort = new AbortController();
  let askId: string | undefined;
  const disconnected: Outbound = {
    async send(_to, options) {
      askId = options.messageId;
      return delivered;
    },
    cancelAsk() {
      assert.fail("A disconnected client cannot cancel asks");
    },
    isConnected: () => false,
  };
  const asking = messaging.ask(disconnected, peer, "question", abort.signal);
  abort.abort();
  await assert.rejects(asking, /cancelled/);
  assert.ok(askId);

  const cancelled: string[] = [];
  const cancelAsk = (id: string) => { cancelled.push(id); };
  const interrupted = {
    cancelAsk,
    async listSessions() {
      throw new Error("Connection lost");
    },
  };
  await assert.rejects(messaging.cancelAbandonedAsks(interrupted), /Connection lost/);
  const reconnected = { cancelAsk, listSessions: async () => [] };
  const unrelated = new Messaging(1000, "different-session", pendingAskCancellations);
  await unrelated.cancelAbandonedAsks(reconnected);
  assert.deepEqual(cancelled, [askId]);
  const replacement = new Messaging(1000, sessionId, pendingAskCancellations);
  await replacement.cancelAbandonedAsks(reconnected);
  await replacement.cancelAbandonedAsks(reconnected);
  assert.deepEqual(cancelled, [askId, askId]);
});

test("reply uses the inbound ask ID and preserves a pending ask when delivery can be retried", async () => {
  const messaging = new Messaging(1000, sessionId);
  assert.equal(messaging.accept(peer, inbound("ask-id", { expectsReply: true })), "inbound");
  let attempt = 0;
  const client: Pick<IntercomClient, "send"> = {
    async send(to, options) {
      assert.equal(to, peer.id);
      assert.equal(options.replyTo, "ask-id");
      attempt += 1;
      return attempt === 1 ? { ...delivered, delivered: false, delivery: "failed" } : delivered;
    },
  };
  await messaging.reply(client, "answer", {});
  assert.equal(messaging.tracker.listPending().length, 1);
  await messaging.reply(client, "answer", { replyTo: "ask-id" });
  assert.equal(messaging.tracker.listPending().length, 0);
});

test("target resolution prefers exact IDs and rejects ambiguous names", () => {
  const other = { ...peer, id: "other-session", name: "backend" };
  assert.equal(resolveAskTarget([peer, other], "peer-session"), peer);
  assert.equal(resolveAskTarget([peer, other], "other-"), other);
  assert.throws(() => resolveAskTarget([peer, other], "BACKEND"), /Multiple sessions/);
});

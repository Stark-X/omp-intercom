import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { IntercomSession } from "../src/adapter/session.ts";
import { IntercomClient } from "../src/vendor/pi-intercom/broker/client.ts";
import { loadConfig } from "../src/vendor/pi-intercom/config.ts";

async function connectPeers(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "omp-intercom-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory };
  const brokerPath = fileURLToPath(new URL("../src/vendor/pi-intercom/broker/broker.ts", import.meta.url));
  const broker = spawn(process.execPath, ["--import", "tsx", brokerPath], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const peer = new IntercomClient(env);
  const api = { getSessionName: () => "omp", sendMessage() {} } as ExtensionAPI;
  const context = {
    cwd: directory,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "omp" },
  } as ExtensionContext;
  const config = loadConfig(join(directory, "config.json"));
  const session = new IntercomSession(api, context, config, env, 60_000, Promise.resolve());

  t.after(async () => {
    await Promise.allSettled([peer.disconnect(), session.stop()]);
    if (broker.exitCode === null && broker.signalCode === null && broker.pid) {
      const exited = once(broker, "exit");
      broker.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  await once(broker.stdout, "data", { signal: t.signal });
  const initial = await session.connect();
  await peer.connect({
    cwd: directory,
    model: "fixture",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  }, "peer");
  return { session, initial, peer };
}

async function dropConnection(client: IntercomClient, signal: AbortSignal) {
  const disconnected = once(client, "disconnected", { signal });
  const socket = Reflect.get(client, "socket") as Socket;
  socket.destroy();
  await disconnected;
}

test("an OMP session can reply to a pending ask after reconnecting", { timeout: 15_000 }, async t => {
  const { session, initial, peer } = await connectPeers(t);
  const ask = await peer.send(session.id, { text: "Question", expectsReply: true, noWake: true });
  assert.equal(ask.delivered, true);
  assert.deepEqual(session.status().pendingAsks.map(({ messageId }) => messageId), [ask.id]);

  await dropConnection(initial, t.signal);
  const reconnected = await session.connect();
  assert.notEqual(reconnected, initial);
  assert.equal(reconnected.sessionId, session.id);
  assert.equal(peer.isConnected(), true);

  const [[, message], reply] = await Promise.all([
    once(peer, "message", { signal: t.signal }),
    session.messaging.reply(reconnected, "Answer", { replyTo: ask.id }),
  ]);
  assert.equal(reply.result.delivered, true);
  assert.equal(message.replyTo, ask.id);
  assert.equal(message.content.text, "Answer");
  assert.deepEqual(session.status().pendingAsks, []);
});

test("a peer can ask after OMP reconnects and abandons its outbound ask", { timeout: 15_000 }, async t => {
  const { session, initial, peer } = await connectPeers(t);
  const target = (await initial.listSessions()).find(entry => entry.id === peer.sessionId);
  assert.ok(target);
  const received = once(peer, "message", { signal: t.signal });
  const outcome = session.messaging.ask(initial, target, "First question").catch((error: unknown) => error);
  const [, outbound] = await received;
  assert.equal(outbound.expectsReply, true);
  // Wait for the broker's delivery response before dropping the sender socket.
  await initial.listSessions();

  await dropConnection(initial, t.signal);
  assert.match(String(await outcome), /Client disconnected/);
  await session.connect();

  const inbound = await peer.send(session.id, { text: "Question in reverse", expectsReply: true, noWake: true });
  assert.equal(inbound.delivered, true, inbound.code ?? inbound.reason);
  assert.deepEqual(session.status().pendingAsks.map(({ messageId }) => messageId), [inbound.id]);
});

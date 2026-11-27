import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { IntercomSession } from "../src/adapter/session.ts";
import { IntercomClient } from "../src/vendor/pi-intercom/broker/client.ts";
import { loadConfig } from "../src/vendor/pi-intercom/config.ts";

test("an OMP session can reply to a pending ask after reconnecting", { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "omp-intercom-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory };
  const brokerPath = fileURLToPath(new URL("../src/vendor/pi-intercom/broker/broker.ts", import.meta.url));
  const broker = spawn(process.execPath, ["--import", "tsx", brokerPath], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const sender = new IntercomClient(env);
  const api = { getSessionName: () => "receiver", sendMessage() {} } as ExtensionAPI;
  const context = {
    cwd: directory,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "receiver" },
  } as ExtensionContext;
  const config = loadConfig(join(directory, "config.json"));
  const receiver = new IntercomSession(api, context, config, env, 60_000, Promise.resolve());

  t.after(async () => {
    await Promise.allSettled([sender.disconnect(), receiver.stop()]);
    if (broker.exitCode === null && broker.signalCode === null && broker.pid) {
      const exited = once(broker, "exit");
      broker.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  await once(broker.stdout, "data", { signal: t.signal });
  const initial = await receiver.connect();
  await sender.connect({
    cwd: directory,
    model: "fixture",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  }, "sender");
  const ask = await sender.send(receiver.id, { text: "Question", expectsReply: true, noWake: true });
  assert.equal(ask.delivered, true);
  assert.deepEqual(receiver.status().pendingAsks.map(({ messageId }) => messageId), [ask.id]);

  const disconnected = once(initial, "disconnected", { signal: t.signal });
  const socket = Reflect.get(initial, "socket") as Socket;
  socket.destroy();
  await disconnected;

  const reconnected = await receiver.connect();
  assert.notEqual(reconnected, initial);
  assert.equal(reconnected.sessionId, receiver.id);
  assert.equal(sender.isConnected(), true);

  const [[, message], reply] = await Promise.all([
    once(sender, "message", { signal: t.signal }),
    receiver.messaging.reply(reconnected, "Answer", { replyTo: ask.id }),
  ]);
  assert.equal(reply.result.delivered, true);
  assert.equal(message.replyTo, ask.id);
  assert.equal(message.content.text, "Answer");
  assert.deepEqual(receiver.status().pendingAsks, []);
});

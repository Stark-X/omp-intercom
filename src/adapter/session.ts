import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { english, type Translate } from "../i18n/index.ts";
import { IntercomClient } from "../vendor/pi-intercom/broker/client.ts";
import { spawnBrokerIfNeeded } from "../vendor/pi-intercom/broker/spawn.ts";
import { getIntercomScopeId, setIntercomScopeId, type IntercomConfig } from "../vendor/pi-intercom/config.ts";
import type { Message, SessionInfo } from "../vendor/pi-intercom/types.ts";
import { Messaging, messageBody, sessionLabel } from "./messaging.ts";

export class IntercomSession {
  readonly hostId: string;
  readonly id: string;
  private readonly lifetime = new AbortController();
  private readonly messagesByPool = new Map<string | undefined, Messaging>();
  private readonly startedAt = Date.now();
  private client?: IntercomClient;
  private connection?: Promise<IntercomClient>;
  private poolChange?: Promise<IntercomClient>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private retryDelay = 1000;
  private lastError?: string;
  private lastPresence?: string;
  private alias?: string;
  private stopped = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    readonly config: IntercomConfig,
    private readonly brokerEnv: NodeJS.ProcessEnv,
    private readonly askTimeoutMs: number,
    private readonly previousShutdown: Promise<void>,
    private readonly pendingAskCancellations: Map<string, string>,
  ) {
    this.hostId = ctx.sessionManager.getSessionId();
    this.id = process.env.OMP_INTERCOM_STABLE_ID?.trim() || config.stableId || this.hostId;
  }

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  get pool(): string | undefined {
    return getIntercomScopeId(this.brokerEnv);
  }

  get brokerAgentDir(): string | undefined {
    return this.brokerEnv.PI_CODING_AGENT_DIR;
  }

  get messaging(): Messaging {
    const pool = this.pool;
    const existing = this.messagesByPool.get(pool);
    if (existing) return existing;
    const owner = JSON.stringify([this.id, pool ?? null]);
    const messages = new Messaging(this.askTimeoutMs, owner, this.pendingAskCancellations);
    this.messagesByPool.set(pool, messages);
    return messages;
  }

  private isCurrent(): boolean {
    return !this.stopped && this.ctx.sessionManager.getSessionId() === this.hostId;
  }

  private presence() {
    const name = this.alias || process.env.OMP_INTERCOM_NAME?.trim() || this.pi.getSessionName()?.trim();
    const model = this.ctx.model;
    const usage = this.ctx.getContextUsage?.();
    return {
      name: name || `omp-${this.id.slice(0, 18)}`,
      runtimeFallbackAlias: !name,
      model: model ? `${model.provider}/${model.id}` : "unknown",
      status: this.ctx.isIdle() ? "idle" : "busy",
      ...(usage && Number.isFinite(usage.percent) && Number.isFinite(usage.tokens) && usage.contextWindow > 0
        ? { contextPct: Math.round(usage.percent), contextTokens: usage.tokens, contextWindow: usage.contextWindow }
        : {}),
    };
  }

  async setAlias(alias: string): Promise<void> {
    this.signal.throwIfAborted();
    await this.pi.setSessionName(alias);
    this.signal.throwIfAborted();
    this.alias = alias;
    this.refreshPresence();
  }

  refreshPresence(): void {
    if (!this.isCurrent() || !this.client?.isConnected()) return;
    const presence = this.presence();
    const next = JSON.stringify(presence);
    if (next === this.lastPresence) return;
    try {
      this.client.updatePresence({ contextPct: null, contextTokens: null, contextWindow: null, ...presence });
      this.lastPresence = next;
    } catch (error) {
      this.lastError = String(error);
    }
  }

  status() {
    return {
      id: this.id,
      pool: this.pool ?? "default",
      ...this.presence(),
      connection: this.client?.isConnected() ? "connected" : this.connection ? "connecting" : "offline",
      ...(this.lastError ? { lastError: this.lastError } : {}),
      pendingAsks: this.messaging.tracker.listPending().map(({ from, message }) => ({
        from: sessionLabel(from),
        fromId: from.id,
        messageId: message.id,
      })),
    };
  }

  start(): void {
    void this.connect().catch(() => {});
    this.presenceTimer = setInterval(() => this.refreshPresence(), 2000);
    this.presenceTimer.unref();
  }

  connect(): Promise<IntercomClient> {
    return this.poolChange ?? this.connectCurrentPool();
  }

  switchPool(pool: string | undefined, t: Translate = english): Promise<IntercomClient> {
    if (this.poolChange) throw new Error(t("poolSwitchInProgress"));
    if (pool === this.pool) return this.connectCurrentPool();
    this.poolChange = this.changePool(pool, t).finally(() => { this.poolChange = undefined; });
    return this.poolChange;
  }

  private async changePool(pool: string | undefined, t: Translate): Promise<IntercomClient> {
    await this.connection?.catch(() => {});
    this.signal.throwIfAborted();
    if (this.messaging.hasOutboundAsks) throw new Error(t("poolPendingAsk"));

    const previous = this.client;
    this.client = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDelay = 1000;
    setIntercomScopeId(pool, this.brokerEnv);
    setIntercomScopeId(pool);
    await previous?.disconnect();
    return this.connectCurrentPool();
  }

  private connectCurrentPool(): Promise<IntercomClient> {
    if (!this.isCurrent()) return Promise.reject(new Error("Intercom session is closed"));
    if (this.connection) return this.connection;
    if (this.client?.isConnected()) return Promise.resolve(this.client);

    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connection = this.open().catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect();
      throw error;
    }).finally(() => {
      this.connection = undefined;
    });
    return this.connection;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort(new Error("Intercom session ended"));
    clearTimeout(this.retryTimer);
    clearInterval(this.presenceTimer);
    for (const messaging of this.messagesByPool.values()) messaging.close(new Error("Intercom session ended"));
    await this.poolChange?.catch(() => {});
    await this.connection?.catch(() => {});
    const client = this.client;
    if (client?.isConnected()) {
      await this.messaging.cancelAbandonedAsks(client).catch(() => {
        // Keep unconfirmed cancellations for the next session with this broker ID.
      });
    }
    await client?.disconnect();
    await this.previousShutdown;
  }

  private async open(): Promise<IntercomClient> {
    await this.previousShutdown;
    if (!this.isCurrent()) throw new Error("Intercom session ended");
    await spawnBrokerIfNeeded(this.config.brokerCommand, this.config.brokerArgs, this.brokerEnv);
    if (!this.isCurrent()) throw new Error("Intercom session ended");

    const client = new IntercomClient(this.brokerEnv);
    this.client = client;
    client.on("error", error => { this.lastError = error.message; });
    client.on("disconnected", (error: Error) => {
      if (this.client !== client || !this.isCurrent()) return;
      this.lastError = error.message;
      this.messaging.rejectOutboundAsks(error);
      this.scheduleReconnect();
    });
    client.on("message", (from: SessionInfo, message: Message) => this.receive(client, from, message));
    client.onMessageControl((from, control) => {
      if (this.client !== client || !this.isCurrent()) return;
      const pending = this.messaging.tracker.listPending().find(entry => entry.message.id === control.messageId);
      if (pending?.from.id === from.id) this.messaging.tracker.dismissPendingAsk(control.messageId);
    });
    const presence = this.presence();
    await client.connect({
      ...presence,
      cwd: this.ctx.cwd,
      pid: process.pid,
      startedAt: this.startedAt,
      lastActivity: Date.now(),
      acknowledgesReceipts: true,
    }, this.id);
    try {
      await this.messaging.cancelAbandonedAsks(client);
      if (!this.isCurrent() || !client.isConnected()) {
        throw new Error("Intercom connection closed during registration");
      }
    } catch (error) {
      await client.disconnect();
      throw error;
    }
    this.lastError = undefined;
    this.retryDelay = 1000;
    this.lastPresence = JSON.stringify(presence);
    this.refreshPresence();
    return client;
  }

  private scheduleReconnect(): void {
    if (!this.isCurrent() || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect().catch(() => {});
    }, this.retryDelay);
    this.retryTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
  }

  private receive(client: IntercomClient, from: SessionInfo, message: Message): void {
    const receipt = (status: "receiver_received" | "acknowledged" | "expired") => {
      client.sendMessageReceipt({ messageId: message.id, status, timestamp: Date.now() });
    };

    if (this.client !== client || !this.isCurrent()) {
      receipt("expired");
      return;
    }

    const disposition = this.messaging.accept(from, message);
    if (disposition !== "inbound") {
      receipt("acknowledged");
      return;
    }

    const sender = message.crossMachine
      ? `${message.crossMachine.origin.name}@${message.crossMachine.origin.machine} (unverified relay)`
      : sessionLabel(from);
    const kind = message.expectsReply ? "ask" : message.replyTo || message.lateReplyTo ? "reply" : "message";
    const replyHint = this.config.replyHint && message.expectsReply
      ? `\nTo answer, call intercom with action "reply" and replyTo ${JSON.stringify(message.id)}.`
      : "";
    const wake = !message.noWake && (this.config.inboundTrigger === "always"
      || (this.config.inboundTrigger === "replies" && Boolean(message.replyTo || message.lateReplyTo)));

    this.pi.sendMessage({
      customType: "intercom_message",
      content: `Intercom ${kind} from ${JSON.stringify(sender)} (${from.id}, ${from.cwd}).${replyHint}\n\n${messageBody(message)}`,
      display: true,
      details: { from, message },
    }, wake || !this.ctx.isIdle()
      ? { deliverAs: "nextTurn", triggerTurn: wake }
      : { triggerTurn: false });
    receipt("receiver_received");
  }
}

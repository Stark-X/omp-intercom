import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import net from "net";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_STARTUP_STDERR_LIMIT = 4_000;

type BrokerLaunchSpec = {
  command: string;
  args: string[];
  captureStartupStderr: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getTsxLoaderPath(extensionDir: string = EXTENSION_DIR): string {
  // Resolve tsx via Node's module resolution so it works regardless of whether
  // tsx is bundled under extensionDir/node_modules or hoisted to a workspace
  // root by npm. The tsx package main entry is its loader. If resolution
  // fails, prefer the flat plugin-store layout before the legacy nested
  // fallback.
  try {
    const requireFromExtension = createRequire(join(extensionDir, "package.json"));
    return requireFromExtension.resolve("tsx");
  } catch {
    const siblingTsxLoader = join(extensionDir, "..", "tsx", "dist", "loader.mjs");
    if (existsSync(siblingTsxLoader)) {
      return siblingTsxLoader;
    }
    return join(extensionDir, "node_modules", "tsx", "dist", "loader.mjs");
  }
}

function usesDefaultBrokerCommand(brokerCommand: string, brokerArgs: string[]): boolean {
  return brokerCommand === "npx"
    && brokerArgs.length === 2
    && brokerArgs[0] === "--no-install"
    && brokerArgs[1] === "tsx";
}

function getNodeCommand(nodePath: string): string {
  const executableName = nodePath.split(/[\\/]/).pop();
  return executableName && /^node(?:js)?(?:\.exe)?$/i.test(executableName)
    ? nodePath
    : "node";
}

export function isBrokerHealthOkMessage(message: unknown, requestId: string): boolean {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message as Record<string, unknown>;
  return response.type === "health_ok"
    && response.requestId === requestId
    && response.protocol === INTERCOM_PROTOCOL_NAME
    && response.version === INTERCOM_PROTOCOL_VERSION;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  extensionDir: string = EXTENSION_DIR,
  nodePath: string = process.execPath,
): BrokerLaunchSpec {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    // Load tsx in the broker process itself. The tsx CLI would re-spawn Node
    // without windowsHide, and that grandchild opens a visible console window
    // on Windows because the detached broker has no console to share.
    return {
      command: getNodeCommand(nodePath),
      args: ["--import", pathToFileURL(getTsxLoaderPath(extensionDir)).href, brokerPath],
      captureStartupStderr: true,
    };
  }

  return {
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
    captureStartupStderr: false,
  };
}

export function getBrokerSpawnOptions(
  env: NodeJS.ProcessEnv = process.env,
  captureStderr = true,
): {
  detached: true;
  stdio: "ignore" | ["ignore", "ignore", "pipe"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  const agentDir = getAgentDirPath(env);
  return {
    detached: true,
    stdio: captureStderr ? ["ignore", "ignore", "pipe"] : "ignore",
    // Windows locks a process's cwd against renames, so keep it outside the package.
    cwd: getIntercomDirPath(agentDir),
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    windowsHide: true,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(
  brokerCommand: string,
  brokerArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const intercomDir = getIntercomDirPath(getAgentDirPath(env));
  const brokerPid = join(intercomDir, "broker.pid");
  const spawnLock = join(intercomDir, "broker.spawn.lock");
  ensureIntercomRuntimeDir(intercomDir);

  if (await isBrokerRunning(env, brokerPid)) {
    return;
  }

  const ownsLock = acquireSpawnLock(spawnLock);
  if (!ownsLock) {
    await waitForBroker(env);
    return;
  }

  try {
    if (await isBrokerRunning(env, brokerPid)) {
      return;
    }

    const brokerPath = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions(env, launch.captureStartupStderr));
    let brokerStderr = "";
    const rememberBrokerStderr = (chunk: Buffer | string) => {
      brokerStderr = `${brokerStderr}${chunk.toString()}`.slice(-BROKER_STARTUP_STDERR_LIMIT);
    };
    const brokerStartupError = (message: string, cause?: unknown) => {
      const stderr = brokerStderr.trim();
      const errorMessage = stderr ? `${message}\nBroker stderr:\n${stderr}` : message;
      return cause === undefined ? new Error(errorMessage) : new Error(errorMessage, { cause });
    };
    child.stderr?.on("data", rememberBrokerStderr);
    child.stderr?.unref();
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.stderr?.off("data", rememberBrokerStderr);
        child.stderr?.resume();
        child.off("error", onError);
        child.off("close", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(brokerStartupError(`Failed to spawn intercom broker: ${error.message}`, error));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        if (signal) {
          reject(brokerStartupError(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(brokerStartupError(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };

      child.once("error", onError);
      child.once("close", onExit);
      waitForBroker(env).then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        const startupError = toError(error);
        reject(brokerStartupError(startupError.message, startupError));
      });
    });
  } finally {
    releaseSpawnLock(spawnLock);
  }
}

async function isBrokerRunning(env: NodeJS.ProcessEnv, brokerPid: string): Promise<boolean> {
  if (await checkSocketConnectable(env)) {
    return true;
  }

  if (!existsSync(brokerPid)) return false;

  try {
    const pid = parseInt(readFileSync(brokerPid, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable(env);
  } catch {
    // Missing or unreadable PID state means there is no live broker to reuse.
    return false;
  }
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

type EndpointState = "broker" | "absent" | "unresponsive";

/**
 * "absent": nothing listens, or whatever owns the endpoint closed or answered without a broker
 * health reply. "unresponsive": connected but silent for 1s, or failed in an unexpected way.
 */
export function probeBrokerEndpoint(target: BrokerConnectTarget): Promise<EndpointState> {
  return new Promise((resolve) => {
    const socket = connectToBrokerTarget(target);
    const requestId = randomUUID();
    const finish = (state: EndpointState) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(state);
    };
    socket.on("connect", () => writeMessage(socket, {
      type: "health",
      requestId,
      ...(typeof target === "string" || !target.stateId ? {} : { stateId: target.stateId }),
    }));
    socket.on("data", createMessageReader(
      (message) => finish(isBrokerHealthOkMessage(message, requestId) ? "broker" : "absent"),
      () => finish("absent"),
    ));
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ENOENT" || code === "ECONNREFUSED" ? "absent" : "unresponsive");
    });
    socket.on("close", () => finish("absent"));
    const timeout = setTimeout(() => finish("unresponsive"), 1000);
  });
}

async function checkSocketConnectable(env: NodeJS.ProcessEnv): Promise<boolean> {
  let target: BrokerConnectTarget;
  try {
    target = getBrokerConnectTarget(process.platform, env);
  } catch {
    return false;
  }
  return await probeBrokerEndpoint(target) === "broker";
}

function acquireSpawnLock(spawnLock: string): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(spawnLock, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE,
      });
      restrictIntercomRuntimeFile(spawnLock);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale(spawnLock)) {
        try {
          unlinkSync(spawnLock);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(spawnLock: string): boolean {
  if (!existsSync(spawnLock)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(spawnLock, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(spawnLock: string): void {
  try {
    unlinkSync(spawnLock);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable(env)) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}

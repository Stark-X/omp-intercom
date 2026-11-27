import { spawn } from "child_process";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs";
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

const PACKAGE_DIR = fileURLToPath(new URL("../../../../", import.meta.url));
const BROKER_STARTUP_STDERR_LIMIT = 4_000;

type BrokerLaunchSpec = {
  command: string;
  args: string[];
  captureStartupStderr: boolean;
  envOverrides?: NodeJS.ProcessEnv;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getTsxLoaderPath(packageDir: string = PACKAGE_DIR): string {
  // The package's dependency can be hoisted or installed alongside the real
  // package directory in a symlinked Bun plugin store.
  const requireFromPackage = createRequire(join(realpathSync(packageDir), "package.json"));
  return requireFromPackage.resolve("tsx");
}

function usesDefaultBrokerCommand(brokerCommand: string, brokerArgs: string[]): boolean {
  return brokerCommand === "npx"
    && brokerArgs.length === 2
    && brokerArgs[0] === "--no-install"
    && brokerArgs[1] === "tsx";
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
  packageDir: string = PACKAGE_DIR,
  execPath: string = process.execPath,
): BrokerLaunchSpec {
  if (!usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return {
      command: brokerCommand,
      args: [...brokerArgs, brokerPath],
      captureStartupStderr: false,
    };
  }

  if (process.versions.bun) {
    // OMP uses the same switch to run its embedded Bun as a CLI.
    return {
      command: execPath,
      args: ["--no-env-file", brokerPath],
      captureStartupStderr: true,
      envOverrides: { BUN_BE_BUN: "1" },
    };
  }

  let loader: string;
  try {
    loader = getTsxLoaderPath(packageDir);
  } catch (cause) {
    throw new Error(`Intercom could not resolve its tsx dependency in ${packageDir}. Run npm ci in the source checkout or reinstall the plugin.`, { cause });
  }
  // Preload tsx directly so the detached broker doesn't spawn a second
  // Node process without windowsHide.
  return {
    command: execPath,
    args: ["--import", pathToFileURL(loader).href, brokerPath],
    captureStartupStderr: true,
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
    const options = getBrokerSpawnOptions({ ...env, ...launch.envOverrides }, launch.captureStartupStderr);
    const child = spawn(launch.command, launch.args, options);
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

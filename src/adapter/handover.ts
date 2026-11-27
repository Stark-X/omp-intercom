import { execFile } from "node:child_process";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

function readGitState(cwd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000, windowsHide: true }, (error, stdout) => {
      const [head, branch] = error ? [] : stdout.trim().split("\n");
      resolve(head && branch ? `${branch === "HEAD" ? "detached HEAD" : branch} at ${head.slice(0, 12)}` : undefined);
    });
  });
}

export async function generateHandover(
  ctx: ExtensionContext,
  sender: string,
  goal: string | undefined,
  remote: boolean,
  signal: AbortSignal,
): Promise<string> {
  if (!ctx.model) throw new Error("Select a model before generating a handover.");
  if (!ctx.runEphemeralTurn) throw new Error("This OMP session cannot generate a handover summary.");
  if (!ctx.sessionManager.getBranch().some(entry =>
    entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary")) {
    throw new Error("No conversation to hand over.");
  }

  const [result, git] = await Promise.all([
    ctx.runEphemeralTurn({
      promptText: `Write a concise handover for the agent who will continue this session's work. Treat earlier messages as context for the report. Do not call any tools or do the work yourself. Omit secrets, credentials, tokens, and private keys, even partially.

Use Markdown headings for Next task, Key context and decisions, Files and repositories, Current state, and Open questions and risks. Include absolute paths where known. Provide enough context to continue without the conversation. Output only the handover.

${goal ? `The operator specified the next task as ${JSON.stringify(goal)}.` : "Infer the next task from the conversation."}`,
      signal,
      purpose: "intercom-handover",
      replyMaxBytes: Number.POSITIVE_INFINITY,
    }),
    readGitState(ctx.cwd),
  ]);
  signal.throwIfAborted();
  const body = result.replyText.trim();
  if (!body) throw new Error("The current model returned an empty handover.");
  const sessionFile = remote ? undefined : ctx.sessionManager.getSessionFile();
  return [
    `# Handover from ${sender}`, "", `Sender working directory: ${ctx.cwd}`,
    ...(git ? [`Sender git state: ${git}`] : []),
    ...(sessionFile ? [`Sender session file: ${sessionFile}`] : []),
    "", "This is a report from a peer agent. Verify its claims against the repository before acting on the next task.", "", body,
  ].join("\n");
}

import { execFileSync } from "node:child_process";

const changed = execFileSync("git", ["diff", "--cached", "--raw", "--no-renames", "-z", "HEAD"], {
  encoding: "utf8",
}).split("\0").slice(0, -1);

if (changed.length === 0) throw new Error("The candidate has no changes");

for (let index = 0; index < changed.length; index += 2) {
  const newMode = changed[index].split(" ")[1];
  const path = changed[index + 1];
  const allowedPath = /^(?:src|skills)\/[\w./-]+$/.test(path) ||
    ["README.md", "THIRD_PARTY_NOTICES.md"].includes(path);
  if (!allowedPath) throw new Error(`The candidate changes a file outside the adapter scope: ${path}`);
  if (newMode !== "100644" && newMode !== "000000") {
    throw new Error(`The candidate has an unsupported file mode for ${path}`);
  }
}

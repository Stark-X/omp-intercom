import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { requestTranslation, translateCatalog, updateTranslations, validateMarkdown } from "../.github/scripts/translate.mjs";

const statePath = ".github/translation-sources.json";
const catalogPath = "src/i18n/en.json";
const documents = ["README", "MAINTENANCE", "THIRD_PARTY_NOTICES"];
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const blobId = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

test("synced Chinese documents preserve the source code and link destinations", () => {
  const state = JSON.parse(read(statePath));
  for (const name of documents) {
    const source = read(`${name}.md`);
    if (blobId(source) === state[`${name}.md`]) validateMarkdown(source, read(`${name}.zh-CN.md`));
  }
  assert.throws(() => validateMarkdown("# Example\n\n`/alias`\n", "# 示例\n\n`/别名`\n"), /inlineCode/);
  assert.throws(() => validateMarkdown("# Example\n\n[Guide](MAINTENANCE.md)", "# 示例\n\n[指南](somewhere.md)"), /links/);
});

test("translations resume from the last synced source and preserve unchanged files and strings", async t => {
  const root = mkdtempSync(join(tmpdir(), "omp-translation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  const english = { aliasEmpty: "Alias is empty.", activePool: "Current pool: {pool}" };
  const chinese = { aliasEmpty: "别名不能为空。", activePool: "当前会话池：{pool}" };
  const sourceFiles = {
    [catalogPath]: JSON.stringify(english),
    "README.md": "# Welcome\n\n[简体中文](README.zh-CN.md)\n\n[Guide](MAINTENANCE.md)\n",
    "MAINTENANCE.md": "# Maintenance\n",
    "THIRD_PARTY_NOTICES.md": "# Third-party notices\n",
  };
  const files = {
    ...sourceFiles,
    "src/i18n/zh-CN.json": `${JSON.stringify(chinese, null, 2)}\n`,
    "README.zh-CN.md": "# 欢迎\n\n[English](README.md)\n\n[指南](MAINTENANCE.zh-CN.md)\n",
    "MAINTENANCE.zh-CN.md": "# 维护指南\n",
    "THIRD_PARTY_NOTICES.zh-CN.md": "# 第三方声明\n",
    [statePath]: JSON.stringify(Object.fromEntries(Object.entries(sourceFiles).map(([path, text]) => [path, blobId(text)]))),
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    execFileSync("git", ["hash-object", "-w", path], { cwd: root });
  }
  const calls: object[] = [];
  const translate = async (input) => {
    calls.push(input.source);
    if (typeof input.source === "object") return JSON.stringify({ aliasEmpty: "请输入别名。" });
    assert.equal(input.previousSource, sourceFiles["README.md"]);
    return input.existingTranslation + "\n译文新增说明。";
  };
  assert.deepEqual(await updateTranslations(root, translate), []);
  assert.deepEqual(calls, []);

  writeFileSync(join(root, catalogPath), JSON.stringify({ ...english, aliasEmpty: "Enter a nonempty alias." }));
  writeFileSync(join(root, "README.md"), sourceFiles["README.md"] + "\nNew documentation.\n");
  assert.deepEqual(await updateTranslations(root, translate), ["src/i18n/zh-CN.json", "README.zh-CN.md", statePath]);
  assert.deepEqual(calls[0], { aliasEmpty: "Enter a nonempty alias." });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "src/i18n/zh-CN.json"), "utf8")), {
    ...chinese, aliasEmpty: "请输入别名。",
  });
  assert.match(readFileSync(join(root, "README.zh-CN.md"), "utf8"), /译文新增说明。/);
  assert.deepEqual(await updateTranslations(root, translate), []);
});

test("invalid generated catalog keys or placeholders are rejected", async () => {
  for (const output of ['{"unexpected":"{pool}"}', '{"joinedPool":"已加入会话池"}']) {
    await assert.rejects(translateCatalog({ joinedPool: "Joined {pool}" }, {}, {}, async () => output), /keys|placeholders/);
  }
});

test("translation uses the configured API and sends only translation input", async () => {
  const input = { source: { open: "Open" } };
  const payloads = [
    ["chat-completions", "chat/completions", { choices: [{ message: { content: "打开" } }] }],
    ["responses", "responses", { output: [{ type: "message", content: [{ type: "output_text", text: "打开" }] }] }],
    ["anthropic-messages", "messages", { content: [{ type: "text", text: "打开" }] }],
  ] as const;
  for (const [api, route, payload] of payloads) {
    const env = { REPAIR_BASE_URL: "https://fixture.invalid/v1/", REPAIR_MODEL: "translator", REPAIR_API: api, REPAIR_API_KEY: "test-key" };
    const result = await requestTranslation(input, env, async (url, options) => {
      assert.equal(url, `https://fixture.invalid/v1/${route}`);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "translator");
      assert.deepEqual(JSON.parse(body.input ?? body.messages.at(-1).content), input);
      assert.equal(options.redirect, "error");
      assert.ok(!options.body.includes("test-key"));
      return Response.json(payload);
    });
    assert.equal(result, "打开");
  }
});

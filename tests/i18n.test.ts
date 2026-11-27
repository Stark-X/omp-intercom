import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import translationSources from "../.github/translation-sources.json" with { type: "json" };
import en from "../src/i18n/en.json" with { type: "json" };
import zhCN from "../src/i18n/zh-CN.json" with { type: "json" };
import { createTranslator } from "../src/i18n/index.ts";

test("a synced catalog preserves source keys and interpolation placeholders", () => {
  for (const [key, value] of Object.entries(zhCN)) assert.ok(value.trim(), `Empty zh-CN translation for ${key}`);
  const source = readFileSync(new URL("../src/i18n/en.json", import.meta.url));
  const blob = createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex");
  if (blob !== translationSources["src/i18n/en.json"]) return;

  assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(en).sort());
  const placeholders = (message: string) => [...message.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.deepEqual(placeholders(zhCN[key]), placeholders(en[key]), key);
  }
});

test("locale precedence and fallback preserve technical interpolation values", () => {
  assert.equal(createTranslator({ LANG: "zh_CN.UTF-8" })("nextTaskField"), "下一步任务（可选）");
  assert.equal(createTranslator({ LC_MESSAGES: "zh-Hans", LANG: "en_US.UTF-8" })("compose"), "写消息");
  assert.equal(createTranslator({ LC_ALL: "C", LC_MESSAGES: "zh-CN" })("compose"), "Compose");
  assert.equal(createTranslator({ OMP_INTERCOM_LOCALE: "fr", LANG: "zh-CN" })("compose"), "Compose");
  assert.equal(createTranslator({ OMP_INTERCOM_LOCALE: "zh-CN", LC_ALL: "C" })("joinedPool", { pool: "team-{id}" }),
    "已加入 Intercom 会话池：team-{id}");
});

# 维护指南

[English](MAINTENANCE.md) | 简体中文

## 测试

```sh
npm test
python3 tests/cross-harness.py /path/to/pi-intercom/index.ts
```

跨环境测试要求 `PATH` 中有 `omp`、`pi` 和 `pi-intercom`，并使用本地模型测试替身。测试覆盖共享消息代理、跨项目投递、唤醒空闲会话、静默消息、请求与回复的匹配、会话切换和重新连接。

每次推送或提交拉取请求（PR）时，GitHub Actions 的 **Tests** 工作流都会在 Node.js 20 和 24 上运行单元测试，并使用固定版本运行跨环境集成测试。

## 兼容性维护

**Upstream compatibility** 工作流每天在北京时间 05:23（前一天 UTC 21:23）运行。也可以从 **Actions → Upstream compatibility → Run workflow** 手动触发。工作流会解析 Pi、OMP、Bun 和 pi-intercom 在 npm 上的 `latest` 标签所指向的确切版本，然后测试固定版本基线、各项上游更新（OMP 和 Bun 一起测试），以及所有更新同时应用的组合。

如果基线通过，且某个更新后的版本组合能复现故障，工作流就使用 OpenCode 和你配置的模型提供方生成修复补丁。补丁通过单元测试和完整的集成测试矩阵后，工作流会向 `master` 提交 PR，并请求审阅。同一时间只保留一个待处理的自动修复 PR。

### 配置修复所用的模型提供方

请在仓库的 [Actions 变量](https://github.com/Stark-X/omp-intercom/settings/variables/actions)和 [Actions 密钥](https://github.com/Stark-X/omp-intercom/settings/secrets/actions)中添加以下配置。

| 配置项 | 位置 | 值 |
| --- | --- | --- |
| `REPAIR_BASE_URL` | 变量 | GitHub 托管运行器可以访问的 API 地址前缀，例如 `https://gateway.example.com/v1` 或 `https://openrouter.ai/api/v1`。 |
| `REPAIR_MODEL` | 变量 | 提供方的确切模型 ID。请选择支持工具调用的模型。 |
| `REPAIR_API_KEY` | 密钥 | 该 API 端点的访问密钥。 |
| `REPAIR_API` | 可选变量 | `chat-completions`（默认）、`responses` 或 `anthropic-messages`。 |

修复代理会根据所选协议，将 `/chat/completions`、`/responses` 或 `/messages` 附加到 API 地址前缀。代理只能修改适配器源码、技能和项目文档。要自动创建 PR，请在 [Actions 设置](https://github.com/Stark-X/omp-intercom/settings/actions)中启用 **Allow GitHub Actions to create and approve pull requests**。测试和兼容性报告使用本地模型测试替身，无需配置修复所用的模型提供方。

可选的 Actions 变量 `INTERCOM_REVIEWER` 指定修复 PR 的审阅者，默认为仓库所有者。

## 发布

PR 合并到 `master` 后，**Release merged pull request** 工作流会递增 `package.json` 和 `package-lock.json` 中的补丁版本号，推送版本提交与对应的 `vX.Y.Z` tag，并创建 GitHub Release。发布任务依次执行。如果版本提交和 tag 已推送，重跑任务时会沿用它们。分支和 tag 规则需要允许工作流使用 `GITHUB_TOKEN` 推送这两个引用。

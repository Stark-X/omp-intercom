# omp-intercom

[English](README.md) | 简体中文

这是一个 [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) 扩展，支持本地 OMP 和 Pi 会话双向收发消息，包括位于不同仓库的会话。OMP 和 [pi-intercom](https://github.com/nicobailon/pi-intercom) 共用同一个消息代理（broker）。每个 OMP 会话使用同一连接和身份发送、接收和回复消息。

## 安装

已在 OMP **19.2.1** 和 pi-intercom **0.19.0** 上验证。默认的消息代理启动程序要求 `PATH` 中有 Node.js 20 或更高版本。

```sh
git clone https://github.com/Stark-X/omp-intercom.git
cd omp-intercom
npm ci
omp -e "$PWD"
```

将包目录传给 `omp -e` 即可加载扩展及其自带的 `intercom` 技能。要在每次启动时自动加载，请将仓库的绝对路径添加到 OMP `config.yml` 的 `extensions` 列表中。

```yaml
extensions:
  - /absolute/path/to/omp-intercom
```

在 Pi 中运行 `pi install npm:pi-intercom@0.19.0`，安装匹配的版本。Pi 和 OMP 都可以启动消息代理。

## 使用

你可以让 OMP 查找其他会话，或与它们协作。扩展提供 `intercom` 工具。

| 操作 | 参数 | 行为 |
| --- | --- | --- |
| `list` | | 列出已连接的会话及其名称、会话 ID 和工作目录。 |
| `send` | `to`、`message`，可选 `noWake` | 发送消息并报告消息代理是否已投递或将消息加入队列。 |
| `ask` | `to`、`message` | 向已连接的会话提问并等待对应的回复。 |
| `reply` | `message`，可选 `replyTo` 和 `to` | 回复收到的提问。如果有多个待回复的提问，请用 `replyTo` 指定要回复的提问。 |
| `status` | | 显示当前会话 ID、连接状态和待回复的提问。 |

可以使用目标会话的名称或唯一的会话 ID 前缀。名称重复时，请使用完整的会话 ID。默认情况下，收到的消息会唤醒空闲的 OMP 会话。会话正在处理当前轮次时，收到的消息会排队，留待后续轮次处理。设置 `noWake: true` 后，会话仍可读取消息，消息本身不会启动新一轮处理。

## 配置

OMP 默认使用 Pi 的消息代理目录 `~/.pi/agent/intercom/`。如果 Pi 设置了自定义的 `PI_CODING_AGENT_DIR`，请在启动 OMP 时将 `OMP_INTERCOM_PI_AGENT_DIR` 指向同一个 **Pi 代理目录**。OMP 仍使用独立的代理目录。如果设置了 `PI_INTERCOM_SCOPE_ID`，请在 Pi 和 OMP 中使用相同的值。

```sh
OMP_INTERCOM_PI_AGENT_DIR=/path/to/pi-agent OMP_INTERCOM_NAME=frontend omp -e "$PWD"
```

扩展默认使用 OMP 的会话 ID 和名称。`OMP_INTERCOM_NAME` 可以覆盖显示名称，`OMP_INTERCOM_STABLE_ID` 可以固定某个 OMP 实例在消息代理中的地址。并行运行的实例应各自使用不同的稳定 ID。`PI_INTERCOM_ASK_TIMEOUT_MS` 默认为 600000 毫秒（10 分钟）。请为各客户端和启动消息代理的进程使用相同的值。

可选设置写在当前 OMP 代理目录的 `intercom/config.json` 中。默认的代理目录为 `~/.omp/agent/`。

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "confirmSend": false,
  "replyHint": true
}
```

将 `inboundTrigger` 设为 `replies` 时，只有回复会唤醒会话。设为 `never` 时，收到的消息不会唤醒会话。对已发出且尚未完成的 `ask`，收到对应回复时始终会结束该工具调用的等待。启用 `confirmSend` 会在交互式会话执行 `send` 和 `ask` 前提示确认。也可以设置 `stableId`、`brokerCommand` 和 `brokerArgs`。

开发测试和仓库自动化请参阅[维护指南](MAINTENANCE.zh-CN.md)。

## 许可证

本项目采用 MIT 许可证。适配器内置了 Nico Bailon 的 pi-intercom v0.19.0 中的消息代理和客户端。详见[第三方声明](THIRD_PARTY_NOTICES.md)。

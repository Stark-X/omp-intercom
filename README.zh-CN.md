# omp-intercom

[English](README.md) | 简体中文

这是一个 [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) 扩展，支持会话间收发消息和交接工作。交互式命令使用 OMP 的终端界面。本地 OMP 和 Pi 会话通过 [pi-intercom](https://github.com/nicobailon/pi-intercom) 共用一个消息代理（broker），也可以在不同仓库之间通信。

## 安装

已在 OMP **19.2.1** 和 pi-intercom **0.19.0** 上验证。OMP 默认用自身的 Bun 运行时启动消息代理。OMP 独立版已内置 Bun。

### 使用 OMP 插件管理器

```sh
omp plugin install github:Stark-X/omp-intercom
```

下次启动 OMP 时会加载已安装的插件。要获取仓库默认分支的新提交，运行 `omp plugin upgrade omp-intercom`，然后重启 OMP。要安装指定版本，可以在安装来源后加上 `#vX.Y.Z` 格式的 GitHub tag。

### 从本地仓库加载

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

### 键盘操作

- `/intercom` 或 **Alt+Shift+M** 打开会话列表。选中会话后，按 **Enter** 写消息，或按 **H** 发起交接。OMP 的 **Alt+M** 用于选择模型。
- `/handover` 打开交接会话选择器。也可以输入 `/handover <会话> [下一步任务]`，用名称或会话 ID 指定接收方，或输入 `/handover <项目路径> [下一步任务]` 指定项目。名称或路径包含空格时请加引号。OMP 用当前模型生成摘要，编辑后按 **Ctrl+Q** 发送，按 **Esc** 取消。
- `/intercom-id` 将当前会话的 Intercom 联系方式插入输入框。
- `/intercom-pool [名称|default]` 查看或切换当前的通信池。同一池内的会话可以互相发现。请在发出的提问收到回复或取消后再切换。
- `/alias <名称>` 设置当前会话的别名。输入 `/alias` 或 `/alias menu` 可以打开重命名对话框。

按项目路径交接时，OMP 会使用该目录下已连接的会话。如果该目录下没有已连接的会话，并且当前运行在 Herdr 中，OMP 可以为项目打开一个新面板。交接选择器也可以查找已启用的 Herdr 机器上的会话。用 `/handover <名称@机器> [下一步任务]` 可以直接指定远程会话。远程交接通过 SSH 和接收机器上的 `pi-intercom` 命令行中继发送。

### 让 agent 执行

你可以通过 `intercom` 工具或 `/skill:intercom` 让 OMP 查找其他会话并与它们协作。

| 操作 | 参数 | 行为 |
| --- | --- | --- |
| `list` | | 列出已连接的会话及其名称、会话 ID 和工作目录。 |
| `send` | `to`、`message`，可选 `noWake` | 发送消息并报告消息代理是否已投递或将消息加入队列。 |
| `ask` | `to`、`message` | 向已连接的会话提问并等待对应的回复。 |
| `reply` | `message`，可选 `replyTo` 和 `to` | 回复收到的提问。如果有多个待回复的提问，请用 `replyTo` 指定要回复的提问。 |
| `status` | | 显示当前会话 ID、连接状态、通信池和待回复的提问。 |

可以使用目标会话的名称或唯一的会话 ID 前缀。名称重复时，请使用完整的会话 ID。默认情况下，收到的消息会唤醒空闲的 OMP 会话。会话正在处理当前轮次时，收到的消息会排队，留待后续轮次处理。设置 `noWake: true` 后，会话仍可读取消息，消息本身不会启动新一轮处理。

## 配置

OMP 默认使用 Pi 的消息代理目录 `~/.pi/agent/intercom/`。如果 Pi 设置了自定义的 `PI_CODING_AGENT_DIR`，请在启动 OMP 时将 `OMP_INTERCOM_PI_AGENT_DIR` 指向同一个 **Pi 代理目录**。OMP 仍使用独立的代理目录。如果设置了 `PI_INTERCOM_SCOPE_ID`，请在 Pi 和 OMP 中使用相同的值。

```sh
OMP_INTERCOM_PI_AGENT_DIR=/path/to/pi-agent OMP_INTERCOM_NAME=frontend omp -e "$PWD"
```

扩展默认使用 OMP 的会话 ID 和名称。`OMP_INTERCOM_NAME` 设置启动时的显示名称，`/alias` 可以在会话中修改它。`OMP_INTERCOM_STABLE_ID` 可以固定某个 OMP 实例在消息代理中的地址。并行运行的实例应各自使用不同的稳定 ID。`PI_INTERCOM_ASK_TIMEOUT_MS` 默认为 600000 毫秒（10 分钟）。请为各客户端和启动消息代理的进程使用相同的值。

可选设置写在当前 OMP 代理目录的 `intercom/config.json` 中。默认的代理目录为 `~/.omp/agent/`。

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "confirmSend": false,
  "replyHint": true
}
```

将 `inboundTrigger` 设为 `replies` 时，只有回复会唤醒会话。设为 `never` 时，收到的消息不会唤醒会话。对已发出且尚未完成的 `ask`，收到对应回复时始终会结束该工具调用的等待。启用 `confirmSend` 会在交互式会话发消息、提问或交接前提示确认。也可以设置 `stableId`、`brokerCommand` 和 `brokerArgs`。远程投递的 `crossMachine.remoteCommand` 默认为 `pi-intercom`。

开发测试和仓库自动化请参阅[维护指南](MAINTENANCE.zh-CN.md)。

## 许可证

本项目采用 MIT 许可证。适配器内置了 Nico Bailon 的 pi-intercom v0.19.0 中共用的 Intercom 代码。详见[第三方声明](THIRD_PARTY_NOTICES.md)。

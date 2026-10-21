# Agent Pigeon

把任务交给 coding agent，保留可续接的对话，并在执行期间追加指令。从终端、Claude Code、Hermes 或其他宿主调用同一个 `pigeon` CLI。

[English](README.md)

**宿主**是你发起任务的地方，**runner** 是实际执行任务的后端，两者可以自由组合。例如，从 Claude Code 调度 Codex，或从 Hermes 调度 Claude。Pigeon 保存会话、执行状态、结果和收集到的历史；集成插件负责调用 CLI。

## 从源码安装

需要 **Node.js >=22.13**、npm，以及已安装的 runner（`claude`、`codex` 或 `hermes`）。进程管理主要面向 macOS/Linux。Node 22 可能输出 SQLite 实验性功能提示。

```sh
npm install
npm link --workspace agent-pigeon
pigeon --help
pigeon capabilities --json
pigeon config validate --json
```

在仓库根目录执行 install/link，并保留链接指向的源码目录。完成 `npm install` 后，也可直接运行 `node /absolute/path/to/agent-pigeon/packages/cli/src/index.mjs ...`。开发安装使用本地 workspace；CLI 同时提供 `pigeon` 和 `agent-pigeon` 命令。

## 启动、追加指令、取得结果

进入 agent 应该工作的目录，提供任务、相关上下文和验收要求：

```sh
pigeon run --runner codex --background --json -- "检查 src 并报告缺陷"
```

CLI 等到 runner 控制通道 ready 后返回 `session_id`、`execution_id` 和 `status`，通常为 `running`；快速任务也可能已到 `completed`。启动默认最多等待 **120 秒**，可通过 `PIGEON_STARTUP_TIMEOUT_MS`（毫秒）调整。启动结束后，任务继续在后台执行。

![Agent Pigeon 流程：提交任务，runner 就绪后返回 ID，立即启动宿主后台 wait，向当前执行追加指令，取得结果，再续接会话创建下一轮执行。](docs/assets/pigeon-flow.svg)

保存两个 ID：session（`pgs_...`）是一段持续对话，execution（`pge_...`）是其中一轮。将下面的占位 ID 换成实际返回值：

```sh
# Agent：提交返回后立即通过宿主后台任务工具启动这条命令。
# 在终端直接执行时，它会等待当前 execution 到达终态。
pigeon wait pge_EXECUTION --json

# 执行期间，向同一个 execution 追加指令。
pigeon steer pge_EXECUTION --json -- "优先检查失败的登录测试"
pigeon messages pgs_SESSION -n 10

# 读取最终结果，再续接会话，创建下一轮 execution。
pigeon result pge_EXECUTION --json
pigeon resume pgs_SESSION --background --json -- "现在补回归测试"
```

**Agent 默认流程：** 后台 run/resume 成功返回后，立即通过宿主后台任务启动 `wait EXECUTION --json`，再结束当前宿主回合。Claude Bash 使用 `run_in_background: true`，由 waiter 触发完成通知。提交调用的超时应覆盖启动等待并留余量，**默认设为 150 秒**。返回 `running` 后可直接 steer，无需先轮询 status 确认就绪。控制响应会说明指令的投递状态；新指令到达前，原执行也可能已经结束。

需要状态快照时使用 `status EXECUTION --json`，取消使用 `cancel EXECUTION --json`，查看事件使用 `events EXECUTION --json`。`messages` 默认展示简化历史，需要结构化数据时再加 `--raw`。`events --follow` 会持续观察，应放在宿主后台任务中运行。

启动失败返回非零退出码和 error JSON。已创建 execution 时，顶层 `session_id`、`execution_id`、`status` 可用于后续查询。若提交响应丢失，先检查 `pigeon executions --json` 再决定是否重试；若状态为 `unknown`，先核查后端和事件。Ready 现指 runner 控制就绪，替代旧的 manager 已启动确认；任务最终结果由终态 status/result 提供。

## 选择执行路由

省略 provider 和 preset 时，`--runner codex` 使用该 runner 已有的认证与配置。需要配置服务时，创建 `$PIGEON_HOME/config.json`，默认路径为 `~/.pigeon/config.json`：

```json
{
  "version": 2,
  "providers": {
    "service": {
      "protocols": ["openai-responses"],
      "base_url": {"openai-responses": "https://example.com/v1"},
      "api_key_env": "PIGEON_SERVICE_KEY"
    }
  },
  "presets": {
    "coding": {
      "provider": "service",
      "runner": "codex",
      "model": "REPLACE_WITH_REAL_MODEL_ID"
    }
  }
}
```

替换端点和模型，设置对应环境变量，再执行 `pigeon config validate --json`。之后可用 `pigeon run --preset coding --background --json -- "任务内容"` 提交。`--model` 指定后端真实模型 ID，`--preset` 选择保存的选项组合；显式参数覆盖 preset。Resume 沿用会话的路由和工作目录。

Claude 对应 `anthropic-messages`，Codex 对应 `openai-responses`，Hermes 对应 `openai-chat-completions`。显式免认证 provider（`auth.type: none`）目前由 Codex 支持；Claude 和 Hermes 使用 API key 或 runner 已有认证。Capabilities 说明支持的控制能力和限制，config validate 检查路由配置。详见[配置、认证、状态和存储](docs/standalone.md)。

## 宿主集成

| 宿主 | 入口 | 完成结果获取 |
|---|---|---|
| 终端/程序 | `pigeon` CLI | wait、events、status/result |
| Claude Code | [Claude 插件](integrations/claude-code) | 提交后立即启动宿主后台 wait |
| Hermes | [Hermes 插件](integrations/hermes) | `pigeon` 工具和 `/pigeon`；后续查询 status/result，或单独启动宿主后台 wait |
| 其他支持 skill 的宿主 | [通用 skill](integrations/skills/pigeon/SKILL.md) | 使用宿主支持的后台 wait 和回调 |

本地加载 Claude 插件：

```sh
claude --plugin-dir /absolute/path/to/agent-pigeon/integrations/claude-code
```

然后使用 `/pigeon-standalone:pigeon run --preset coding -- 任务`。复制或缓存后的集成需要 PATH 上的 `pigeon`，或用 `PIGEON_CLI` 指向一个可执行文件/JS 文件。宿主会话结束后，共享 Pigeon 任务继续执行，取消任务需要显式操作。

Hermes 宿主插件没有自动 watcher。它为 run/resume 设置“启动超时加 30 秒”的传输超时，其他操作保留 30 秒。Hermes 作为 **runner** 时连接已有 Gateway；可通过 `PIGEON_HERMES_ROOT` 和 `PIGEON_HERMES_PYTHON` 覆盖环境发现。详见[集成安装和检查方法](docs/integrations.md)。

CLI 的 `result --json` 和终态 `wait --json` 保留完整已存储结果；status/messages 提供有界预览。Hermes 会另行标记宿主响应长度限制造成的截断，完整结果可从直接 CLI 取得。测试区分本机 native runner 执行、模拟 provider 响应及插件装载/传输，具体检查范围见上述文档。

## Legacy Claude 插件

原根目录插件、命令、scripts、hooks 和旧任务继续保留，详见 [Legacy 插件文档](docs/legacy-plugin.zh-CN.md)。

```sh
claude plugin marketplace add luokinging/agent-pigeon
claude plugin install pigeon@pigeon-cc
```

该 marketplace 入口安装 legacy 根插件，`pigeon-cc` 保留为兼容 marketplace 名称。独立集成位于 `integrations/`。旧 `/pigeon:run --session`、模型别名、ID 和存储沿用原语义。旧任务可通过完整 checkout 中的 `pigeon legacy ...` 或原 scripts 管理。独立集成在宿主退出后保持共享任务运行；legacy 清理 hooks 作用于 legacy 任务。

## 许可

MIT

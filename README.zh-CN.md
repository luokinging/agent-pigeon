# Claude Pigeon

> 把一段活委派给**任意厂商的模型**,在**任意兼容的 CLI 客户端**上后台跑,然后取回结果。

**pigeon** 是一个 [Claude Code](https://code.claude.com) 插件。在主 Claude 会话里,你把一个自包含的任务交给 GLM、DeepSeek、Kimi、MiniMax、Qwen、GPT/Codex —— 任何能通过本机某个 CLI 客户端访问到的模型 —— 让它后台跑,跑完取回结果。

[English](./README.md)

---

## 亮点

- **多厂商一套流程** —— 任何 Anthropic 兼容模型用 `claude` CLI 驱动,任何 OpenAI 兼容模型用 `codex`。配一次,统一用。
- **原生 provider,无需 key** —— 用 client 在你机器上已有的认证(它自己的会话,或全局 env)跑模型;多个模型挂在一个原生 provider 上(比如 gpt-xxx + gpt-yyy)可并行。见 [原生 provider](#原生-providerno-key-跑-client)。
- **两种后台模式** —— 骑 Claude Code 原生后台(`/pigeon:run`,跑完自动通知)或 pigeon 自管 job(`/pigeon:work`,扇出与管理)。
- **并行扇出** —— 一次性派发多个任务,用 status / result / cancel / continue 管理。
- **自然语言触发** —— 说"pigeon …"它就帮你路由,不必打斜杠。

## 前置要求

- [Claude Code](https://code.claude.com)。
- 你要用的 client CLI:**`claude`**(驱动 Anthropic 协议模型)和/或 **`codex`**(驱动 OpenAI 协议模型)。
- 每个**已配置** provider 的 API key。挂在**原生 provider**(`codex-native` / `claude-native`)上的模型不需要 —— 复用 client 自己的认证。

## 安装

```bash
claude plugin marketplace add luokinging/pigeon-cc
claude plugin install pigeon@pigeon-cc
```

新开一个 Claude Code 会话 —— `/pigeon:*` 命令(以及 `pigeon` 自然语言触发)即可用。

之后更新到最新版:

```bash
claude plugin marketplace update pigeon-cc   # 先刷新 marketplace 缓存
claude plugin update pigeon@pigeon-cc       # 再拉取最新插件版本
```

重启 Claude Code 生效。

## 快速上手

下文的 `gpt-xxx`、`gpt-yyy`、`glm-xxx`、`GLM-xxx`、`deepseek-xxx` 和 `claude-xxx` 均为占位符,不是可直接运行的模型名。请替换成 provider 支持且你的账号有权使用的模型 ID,并先通过 `/pigeon:config` 配置对应别名。思考档位和上下文长度以实际模型和端点为准。

```text
/pigeon:config                  # 对话式:加模型 —— 已配置的(带 key)或原生的(无 key)
/pigeon:list                    # 看你的模型
/pigeon:run --model gpt-xxx -- 用 5 条要点总结 ./src 的架构   # 原生(你的 Codex),无 key
/pigeon:run --model glm-xxx -- 用 5 条要点总结 ./src 的架构   # 已配置 provider;跑完通知你
```

---

## 原生 provider(无 key 跑 client)

pigeon 里的 **provider** 是模型的来源:它回答模型从哪来、怎么认证。普通 provider 是「一把 key + 一个地址」。**原生 provider** 则是 pigeon **什么都不注入** —— 不给 key、不给地址,client 用它本机已有的那套认证(它自己的会话,或你设的全局 env)。pigeon 只把这次运行和你的 settings/hooks/CLAUDE.md 隔离开,**绝不碰认证**。

内置两个原生 provider,自动存在(永不写进 config),对应 client 装了就出现:

| Provider        | 协议      | Client   |
| --------------- | --------- | -------- |
| `codex-native`  | openai    | `codex`  |
| `claude-native` | anthropic | `claude` |

provider 你不配 —— 你只把**模型**挂上去,每个 pin 自己的 `model_id`。多个模型可以共用一个原生 provider 并行跑。比如「用我的 Codex 跑 gpt-xxx 和 gpt-yyy」:

```jsonc
"models": {
  "gpt-xxx": { "provider": "codex-native", "model_id": "gpt-xxx", "clients": ["codex"] },
  "gpt-yyy": { "provider": "codex-native", "model_id": "gpt-yyy", "clients": ["codex"] }
}
```
```text
/pigeon:run --model gpt-xxx -- ...      # 两个都走你的 Codex 登录、无 key,
/pigeon:run --model gpt-yyy -- ...      # 并行,各跑各的模型
```

- 无 key:你自己能用 `codex` / `claude`,挂在其原生 provider 上的模型就能用。
- `/pigeon:list` 会用**单独一张表**列出本机探测到的原生 provider —— 仅作发现;挂个模型上去才能真正跑。
- model_id 必须是你的 client 接受的(ChatGPT 账号的 Codex 登录只认该账号有权的模型)。

**最快配置 —— 直接让 Claude Code 帮你做。** 在 Claude Code 会话里说:

> 看看是否安装了 `claude` 和 `codex` CLI,有的话帮我把原生 `codex` 和 `claude` 模型配置上。

它会探测 CLI、挑一个能用的 model_id,通过 `/pigeon:config` 把模型加好 —— 不用手写 JSON。

> 注意:原生运行走的是你自己的会话,因此共享其速率限制 —— 大量并行原生 job 可能撞限流。

---

## 配置

配两种之一:**已配置 provider**(GLM、DeepSeek、Kimi… —— 带 key + 地址),或**原生 provider 上的模型**(无 key —— 只在 `codex-native` / `claude-native` 上写 model_id)。

`/pigeon:config` 是**对话式**的,不带参数。直接运行它,pigeon 会反问你要配什么、一步步引导,你用自然语言逐项回答。它**不预设任何 provider 或模型**,只存你告诉它的。

```text
你:    /pigeon:config
pigeon:  要配置什么?(某个 provider 的 endpoint + key · 一个模型 · 某模型的默认 client/effort)
你:    加一个 provider
pigeon:  哪个 provider,走什么协议,base URL 和 API key 是?
你:    叫 zhipu,anthropic 协议,https://open.bigmodel.cn/api/anthropic,key sk-…
pigeon:  在它上面加个模型吗?(provider · 传给 client 的 model_id · 哪些 client 能驱动)
你:    模型 glm-xxx,model_id GLM-xxx,client claude
pigeon:  我将保存:<回显结构化配置>,确认?
你:    确认
```

### 存的是什么

它写入 `~/.pigeon/config.json`(明文 key,在你本机,绝不进仓库)。一个两 provider 的例子:

```jsonc
{
  "version": 1,
  "providers": {
    "zhipu":    { "protocols": ["anthropic"], "base_url": { "anthropic": "https://open.bigmodel.cn/api/anthropic" }, "api_key": "<key>" },
    "deepseek": { "protocols": ["anthropic"], "base_url": { "anthropic": "https://api.deepseek.com/anthropic" },     "api_key": "<key>" }
  },
  "models": {
    "glm-xxx":  { "provider": "zhipu",    "model_id": "GLM-xxx",         "clients": ["claude"], "effort": ["high", "medium", "low"] },
    "deepseek": { "provider": "deepseek", "model_id": "deepseek-xxx", "clients": ["claude"] }
  }
}
```

- `clients` 和 `effort` 都是**有序**的 —— 第一个是默认。
- `effort` 是**可选**的。只有真正支持 effort/思考档位的模型才填;大多数第三方模型没有 effort —— 直接不填。见 [客户端与协议](#客户端与协议)。
- 一个模型的 `clients` 必须能被其 provider 的协议驱动(`claude` 说 `anthropic`,`codex` 说 `openai`)。

---

## 使用

### `/pigeon:list` —— 看已配置什么

```text
/pigeon:list
```
```text
Configured models
MODEL_ID      MODEL     PROVIDER  PROTOCOL   CLIENTS  EFFORT
------------  --------  --------  ---------  -------  ----------------
GLM-xxx       glm-xxx   zhipu     anthropic  claude*  high*,medium,low
deepseek-xxx  deepseek  deepseek  anthropic  claude*

Native models (keyless — your own codex / claude)
MODEL_ID    MODEL    PROVIDER       PROTOCOL   CLIENTS  EFFORT
----------  -------  -------------  ---------  -------  ------
gpt-xxx     gpt-xxx  codex-native   openai     codex*
claude-xxx  opus     claude-native  anthropic  claude*

* = default
```

`MODEL_ID` 是真正发给 client 的 id;`MODEL` 是你的别名(传给 `--model` 的)。两者可以不同(短别名对长 id)也可以相同。

两张表:**Configured models**(带 key 的 provider)和 **Native models**(无 key —— 挂在 `codex-native` / `claude-native` 上,认证继承自 client)。哪张空就不显示哪张。

如果某个原生 provider 本机探测到了(对应 client 已装)但还没挂模型,会有一行提示列出它 —— 纯发现:

```text
Native providers available (no key needed): claude-native — add a model on one with /pigeon:config.
```

挂个模型上去它就进 Native models 表、提示也随之去掉。探测到的原生 provider 都配了模型,就没有这行提示。

### `/pigeon:run` —— 委派、不阻塞、跑完通知我

适合"派一件、拿结果回来"。pigeon 跑模型,跑完 Claude Code 用通知把输出送回主 agent —— 对话**全程不阻塞**,也无需轮询。

```text
/pigeon:run --model glm-xxx -- 写一个匹配 RFC-5322 邮箱地址的正则,并简短解释
```
```text
…(你可以继续干别的;模型跑完时 Claude 把结果带回来)
Pigeon session: run-<uuid>
```

完成后在同一底层线程续接:

```text
/pigeon:run --session run-<uuid> -- 再给这个方案补测试
```

每一轮都通过 Claude Bash `run_in_background: true` 托管,完成后自动通知结果与同一个 pigeon session ID,无需 work job、continue 命令或轮询。首轮成功后将元数据保存在 `~/.pigeon/run-sessions/`(或 `$PIGEON_HOME/run-sessions/`),不保存凭据。续接继承原 model ID、client、effort、工作目录和 provider 身份,模型别名的配置变化不会改变历史线程。原 provider 的 endpoint 和 key 使用当前配置,支持凭据轮换;原生 session 继承 client 认证。同 session 并发续接会被拒绝。失败轮次保留最后成功的元数据,但 client 可能已写入部分线程历史。续接还要求 client 本地线程历史仍然可用。

### `/pigeon:work` —— 委派成可管理的后台 job

适合一次性扇出很多个、或需要 `cancel` / `continue`、或要跨 session 存活。立刻返回 `job-id`,稍后取结果。

```text
/pigeon:work --model glm-xxx -- 重构 src/auth.ts:把 login() 改成 async/await,行为不变
```
```text
✓ Dispatched job glm-xxx-a1b2 in the background (glm-xxx/claude/high).
  Check progress: /pigeon:status glm-xxx-a1b2
  Fetch result:   /pigeon:result glm-xxx-a1b2
```

### `/pigeon:status` —— 查进度

```text
/pigeon:status               # 所有 job
/pigeon:status glm-xxx-a1b2  # 单个 job
```
状态:`queued · running · done · failed · timeout · killed · crashed`(卡住的会标"疑似卡死")。

### `/pigeon:result` —— 取输出

```text
/pigeon:result glm-xxx-a1b2
```

### `/pigeon:continue` —— 在同一线程上追加

复用该 job 的线程,用新指令续接(在其之后、按提交顺序跑)。

```text
/pigeon:continue glm-xxx-a1b2 -- 再给错误分支加个单测
```

### `/pigeon:cancel` —— 停掉一个 job

```text
/pigeon:cancel glm-xxx-a1b2
```

### 并行扇出

每个 `/pigeon:work` 都是独立 job —— 派多个,再逐个收:

```text
/pigeon:work --model glm-xxx  -- 生成数据模型
/pigeon:work --model deepseek -- 写 API handlers
/pigeon:work --model glm-xxx  -- 写测试
/pigeon:status                # 看它们全部
/pigeon:result <job-id>       # 谁好了取谁
```

### 自然语言(不打斜杠)

装好后,直接用 **`pigeon`** 锚点说你的需求 —— `pigeon:dispatch` skill 会帮你路由:

> "**pigeon**,把这个委派给 deepseek,跑完告诉我" · "**pigeon** 支持哪些模型?" · "配置 **pigeon**" · "我的 **pigeon** 任务到哪了?"

---

## `/pigeon:run` vs `/pigeon:work`

| | `/pigeon:run` | `/pigeon:work` |
|---|---|---|
| 机制 | 骑 Claude Code 原生后台任务 | pigeon 自管 detach job |
| 非阻塞 + 自动通知 | ✅ 原生 | ❌(轮询 status / 取 result) |
| 同线程续接 | `run --session <id>`,每轮自动通知 | `continue <job-id>` |
| 自管 status / result / cancel | — | ✅ |
| 适合 | 一件事,"跑完叫我" | 扇出、生命周期管理 |

---

## 工作原理

两层:

- **协议层** —— 一个 model 能被某个 client 驱动,当且仅当该 client 会说的协议在 model endpoint 暴露的协议里。GLM 暴露 Anthropic 协议,所以 `claude` CLI 能驱动它(只需配 base_url + key + model)。只支持自家工具协议的模型,就用那个工具驱动(如 OpenAI Responses 用 `codex`)。
- **应用层** —— slash 命令 + 后台运行时。从 `(model, client, effort)` 解析出一个 job,把 client 作为隔离的 headless 进程起起来,你通过上面的命令交互。

委派运行与你本机配置**隔离**(已配置模型:`claude --bare`;原生 provider 模型:`claude --setting-sources "" --strict-mcp-config`,既保登录又跳过 settings/hooks/CLAUDE.md;`codex --ignore-user-config --ignore-rules` 两者通用),并默认 bypass 权限,让 headless 任务能在其工作目录内读写文件。job 在 per-thread **FIFO** 锁下执行(同线程的 continue 按顺序跑),并以可验证的进程身份追踪(被复用的 PID 绝不会误杀无关进程)。

> 委派出去的子进程**看不到**你的主对话 —— 它只看到你传进去的任务正文(以及 `run --session` 或 `/pigeon:continue` 时它自己的历史线程)。任务需要的上下文请写进任务里,或让它读工作目录下的文件。

---

## 客户端与协议

| 客户端 | 协议 | 可驱动 |
|---|---|---|
| `claude` | anthropic | Claude,以及任何 Anthropic 兼容端点(GLM、DeepSeek、Kimi、MiniMax、Qwen…) |
| `codex` | openai | OpenAI,以及任何 OpenAI 兼容端点 |

**关于 effort。** 每个客户端 CLI *接受*一组固定的 effort/思考档位 —— `claude`:`low / medium / high / xhigh / max`;`codex`:`none / minimal / low / medium / high / xhigh`。但 effort 只有该客户端**自家**的模型才真正生效(`claude` 对 Anthropic 自家模型、`codex` 对 OpenAI 自家模型)。**大多数第三方 Anthropic/OpenAI 兼容模型 —— GLM、DeepSeek、Kimi、MiniMax、Qwen… —— 根本没有 effort/思考控制。** 部分 provider 提供自己的控制方式,请以具体模型和端点的文档为准。所以某模型的 `effort` 列表只填*该模型实际支持的*——往往直接不填。pigeon 只接受既在该模型列表里、又被所选 client 认可的 effort。

新增一个 client = 加一个适配器文件;registry/运行时不用改。

---

## 说明

- **默认不限制执行时长** —— 委派的 agent 可以跑几小时。job 只在跑完、`/pigeon:cancel`、崩溃或会话关闭时结束。想要墙钟上限可按 model/provider 配 `timeout_ms`(毫秒),或用 `PIGEON_TIMEOUT_MS` 环境变量全局设。
- **面向 POSIX**(macOS / Linux):用进程组、信号、`ps` 做存活/身份判定。Windows 为 best-effort。
- API key 以明文存于本机 `~/.pigeon/config.json`。分享过的 key 请及时轮换。
- session 归属用 Claude Code 官方的 `CLAUDE_ENV_FILE` 机制,每个会话的后台 job 会在其 `SessionEnd` 时清理。

## 许可

MIT

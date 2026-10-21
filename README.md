# Agent Pigeon

**Connect agent tools. Run multiple agents in parallel across providers.**

Claude Code, Codex, and Hermes can each delegate through Pigeon and execute delegated tasks. One agent can call several others at once, choose their model providers, follow their progress, exchange messages, and continue their conversations after a task finishes.

[简体中文 · README.zh-CN.md](README.zh-CN.md)

![Claude Code, Codex, and Hermes connect through Pigeon to multiple parallel agent instances grouped by provider.](docs/assets/pigeon-flow.svg)

Run several instances of the same tool alongside other tools. The provider groups illustrate one possible setup; available combinations follow each tool's protocol support.

## One entry point, multiple agents

| Capability | What it enables |
|---|---|
| **Cross-tool delegation** | Call Claude Code, Codex, or Hermes from your current agent for implementation, review, or testing |
| **Parallel execution** | Run independent tasks together, including multiple instances of the same tool |
| **Multiple providers** | Select a provider, model, and reasoning effort for a task, or use the tool's existing setup |
| **Live communication** | Add instructions and let active agents exchange updates |
| **Persistent conversations** | Follow up after a task finishes with its context intact |
| **Unified management** | Read recent messages, retrieve results, and cancel individual tasks |

Pigeon connects and manages the agents; each agent tool does the work. Task-specific configuration stays within the invocation or session, preserving the tool's global settings.

## Get started

### Installation

Paste this into your agent:

> Read https://github.com/luokinging/agent-pigeon and help me install Pigeon.

Choose how to connect Pigeon to your workflow. Once installed, your agent operates Pigeon while you describe the task in the conversation.

| Integration | Use it for | Setup |
|---|---|---|
| **Skill** | Codex and other skill-aware tools, or an agent that can read the instructions directly | [docs/install.md#skill](docs/install.md#skill) |
| **Claude Code plugin** | Delegation and completion notifications in Claude Code | [docs/install.md#claude-code](docs/install.md#claude-code) |
| **Hermes plugin** | Calling and managing other agents from Hermes | [docs/install.md#hermes](docs/install.md#hermes) |
| **CLI** | Scripts, terminals, and custom integrations | [docs/install.md#cli](docs/install.md#cli) |

Requires Node.js 22.13+ and locally installed, configured agent tools. Primarily supports macOS and Linux. The current version installs from source; the steps are in [docs/install.md](docs/install.md).

## Try parallel collaboration

In any agent conversation with Pigeon connected, ask:

> Use Pigeon to run three tasks at once: have one Codex review the API, another Codex review the tests, and Hermes assess the implementation approach. Ask them to analyze only, then summarize their findings for me.

To use different model services, save named presets and select them in your request:

> Use the review preset for the reviews and the research preset for the design analysis. Run them in parallel.

While they work, add instructions or arrange direct communication:

> Tell the reviewers to focus on login first. Give the two review agents each other's communication addresses so they can exchange findings directly.

Follow up when a task finishes:

> Ask the agent that reviewed the API to propose changes based on its findings.

Your current agent assigns tasks, keeps track of communication addresses, and collects results. Independent tasks can run in parallel; coordinate file ownership or use separate working directories when agents edit code.

## Supported tools

| Tool | Can delegate through Pigeon | Can execute tasks |
|---|---|---|
| Claude Code | Plugin or skill | Yes |
| Codex | Skill or CLI | Yes |
| Hermes | Plugin or CLI | Yes |
| Other agent tools | Can connect by reading the skill and running the local CLI | Additional adapters required |

The Claude Code integration uses background waiting to bring completion notifications back automatically. The Hermes plugin currently retrieves results on request. Other integrations use their host's background notification capabilities.

## Models and providers

Use an agent tool's existing login and default model, or explicitly select a provider, model, and reasoning effort. Presets give a name to a common combination so you can reuse it across tasks.

Custom endpoints currently use Anthropic Messages with Claude Code, OpenAI Responses with Codex, and OpenAI Chat Completions with Hermes. Configuration examples: [docs/standalone.md#configuration](docs/standalone.md#configuration).

## Documentation

- Installation: [docs/install.md](docs/install.md)
- Plugins and skills: [docs/integrations.md](docs/integrations.md)
- Configuration and command reference: [docs/standalone.md](docs/standalone.md)
- Agent instructions: [integrations/skills/pigeon/SKILL.md](integrations/skills/pigeon/SKILL.md)
- Repository: https://github.com/luokinging/agent-pigeon

## License

MIT

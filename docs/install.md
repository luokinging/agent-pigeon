# Installation

Connect Pigeon to your preferred agent using a skill or plugin. All integrations use the same local runtime.

Requires Node.js 22.13+, npm, and the agent tools you want to run. Configure and sign in to those tools first. Pigeon primarily supports macOS and Linux.

## CLI

The current development version is available from source. An npm registry release and a standalone installer are not available yet.

```sh
git clone https://github.com/luokinging/agent-pigeon.git
cd agent-pigeon
npm install
npm link --workspace agent-pigeon
pigeon --help
```

Both `pigeon` and `agent-pigeon` commands are installed. Keep the project directory: the linked commands use it. Run `pigeon capabilities --json` to see supported tools and whether their executables are available.

After installing the runtime, choose an integration below. The examples use `/absolute/path/to/agent-pigeon`; replace it with your installation directory.

## Skill

The portable skill is [integrations/skills/pigeon/SKILL.md](../integrations/skills/pigeon/SKILL.md).

Install the `pigeon` folder in your agent's documented skill directory. You can also ask the agent to read the file directly:

> Read /absolute/path/to/agent-pigeon/integrations/skills/pigeon/SKILL.md, then use Pigeon to have Codex review this project.

The agent needs permission to execute the local Pigeon CLI. Skill locations and discovery rules depend on the host tool.

## Claude Code

Load the plugin when starting Claude Code:

```sh
claude --plugin-dir /absolute/path/to/agent-pigeon/integrations/claude-code
```

Then ask in the conversation:

> Use Pigeon to have Codex review the API while Hermes analyzes the test coverage.

The plugin includes the operating skill and a command entry. It instructs Claude to wait for task completion in the background so results return to the conversation.

## Hermes

Install the runtime first, then copy the plugin to Hermes. The following creates a new directory and stops if that directory already exists:

```sh
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
mkdir "${HERMES_HOME:-$HOME/.hermes}/plugins/pigeon" &&
  cp -R /absolute/path/to/agent-pigeon/integrations/hermes/. \
    "${HERMES_HOME:-$HOME/.hermes}/plugins/pigeon/"
hermes plugins enable pigeon
```

Start a new Hermes session and ask it to use Pigeon. Ensure `pigeon` is available on the PATH used by Hermes. This plugin supports delegation, steering, and result queries; check completed work by asking Hermes for the result.

For plugin validation and environment setup, see [docs/integrations.md](integrations.md).

## Optional model configuration

Runner-only calls use the agent tool's own configuration. To select a custom provider or save model presets, follow [docs/standalone.md#configuration](standalone.md#configuration).

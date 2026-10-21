#!/bin/sh
# CLI transport only. Never owns a task or performs host-session cleanup.
set -eu
if [ -n "${PIGEON_CLI:-}" ]; then
  case "$PIGEON_CLI" in
    *.mjs|*.js) exec node "$PIGEON_CLI" "$@" ;;
    *) exec "$PIGEON_CLI" "$@" ;;
  esac
fi
if command -v pigeon >/dev/null 2>&1; then
  exec pigeon "$@"
fi
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_cli="$plugin_root/../../packages/cli/src/index.mjs"
if [ -f "$source_cli" ]; then
  exec node "$source_cli" "$@"
fi
printf '%s\n' 'Pigeon CLI not found. Link/install agent-pigeon on PATH or set PIGEON_CLI to an executable or index.mjs. Source fallback requires a complete repository checkout.' >&2
exit 127

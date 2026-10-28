# Enhanced Subagent Extension

Run durable, in-process Pi subagents with isolated contexts, asynchronous results, follow-up messaging, cold resume, and a terminal manager UI.

This is a separate example from `extensions/subagent/`; the older foreground subprocess example is unchanged.

## Features

- **Model-triggered delegation**: `subagent` starts a fresh child; `subagent_fork` seeds a child with the parent's completed conversation prefix.
- **Immediate start**: delegation returns a child ID after prompt admission rather than waiting for the answer.
- **Automatic completion**: the parent receives a settlement message when the child and its descendants settle.
- **Continuation**: `send_message` steers a running child or resumes its persisted session under the same ID.
- **Control**: `interrupt_agent` stops current work; `list_agents` shows direct children or descendants.
- **TUI manager**: `/subagents` browses the live tree, inspects transcripts, sends follow-ups, and interrupts work.
- **Persistence**: normal Pi session files retain child transcripts and parent-owned catalog records survive reloads.
- **Lifecycle limits**: default maximum delegation depth `1` and `8` active descendants per root session.
- **Trust-aware agent definitions**: user agents load by default; project agents require scope selection and trust/confirmation.

No external execution providers (Codex, Claude Code, ACP, etc.) are used.

## Installation

From the repository root, run the installer:

```bash
packages/coding-agent/examples/extensions/subagent_enhanced/install.sh
```

It links the extension, sample agents, and workflow prompts into `~/.pi/agent/`, backing up conflicting files with a timestamped suffix. Use `--copy` for independent copies, or set `PI_AGENT_DIR` to install somewhere else.

Then run `/reload` in an active Pi session, or restart Pi, and verify with `/subagents`.

Alternatively, symlink everything manually from the repository root:

```bash
mkdir -p ~/.pi/agent/extensions/subagent_enhanced
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent_enhanced/index.ts" ~/.pi/agent/extensions/subagent_enhanced/index.ts
for f in packages/coding-agent/examples/extensions/subagent_enhanced/*.ts; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/extensions/subagent_enhanced/$(basename "$f")
done

mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent_enhanced/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent_enhanced/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

Run `/reload` after installation. The extension auto-discovers from the subdirectory's `index.ts`.

## Uninstallation

```bash
packages/coding-agent/examples/extensions/subagent_enhanced/uninstall.sh
```

The uninstaller removes only symlinks or unchanged copies created by the installer. Modified or unrelated files are skipped. When an installation replaced an existing file, uninstalling restores the latest timestamped backup. Set `PI_AGENT_DIR` to target a different agent directory, then run `/reload` or restart Pi.

## Model tools

### `subagent`

```json
{
  "agent": "scout",
  "description": "Locate auth flow",
  "prompt": "Find the authentication entry points and summarize the request flow with exact file paths.",
  "cwd": "."
}
```

Starts with no parent conversation messages. The prompt must be self-contained. If `agent` is omitted, `worker` is used. If the agent has no `model` frontmatter, it inherits the caller's current model and thinking level.

### `subagent_fork`

Accepts the same parameters. It copies the parent's active branch before the current in-flight turn, so the child can refer to earlier discussion. Later parent messages are not synchronized automatically.

### `send_message`

```json
{ "agent_id": "child-session-id", "message": "Also inspect error handling" }
```

A parent can message a direct child. A child can message its direct parent using the parent ID included in its task guidance. Running targets are steered; inactive direct children are reopened from their session files. The result confirms delivery, not the recipient's reply.

### `interrupt_agent`

```json
{ "agent_id": "child-session-id" }
```

Stops current work without deleting the child or preventing a later resume. Ancestors can interrupt descendants.

### `list_agents`

```json
{ "scope": "children" }
```

Use `descendants` for the full tree. `running` means currently active; `inactive` covers completed, failed, aborted, and interrupted children. Completion notices make status polling unnecessary.

## `/subagents` manager

The manager opens a live catalog with status, label, model, duration, and usage. Select a child to:

- Expand or collapse its descendants.
- View its transcript.
- Send a follow-up, choosing steer or follow-up delivery when it is running.
- Stop its current work.

The footer shows `subagents: N running / M total`. UI browsing does not add model tokens; only actual messages and settlement notices enter model context. The manager requires TUI mode, while model tools also work in print, JSON, and RPC modes.

## Agent definitions

Markdown files use YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: provider/model-id
---

System prompt for the agent.
```

`model` is optional; bare model IDs are accepted only when unambiguous. Locations:

- `~/.pi/agent/agents/*.md`: user agents, loaded by default.
- `.pi/agents/*.md`: project agents, enabled with `agentScope: "project"` or `"both"`.

Project agents override same-named user agents with scope `both`. Untrusted interactive projects ask for confirmation before running project-controlled prompts.

## Lifecycle and persistence

Each child has two states:

1. A durable Pi session containing its ID, transcript, descriptor, and nested catalog.
2. A live activation owning current execution and resources.

After the child and its descendants become idle, the activation is disposed, capacity is released, and the parent receives exactly one settlement notice. The durable session remains. A later message creates a new activation under the same child ID.

On `/reload`, new/resume/fork, or process shutdown, live descendants are aborted and disposed child-first. Restored live records become `interrupted`; they remain discoverable and resumable. `/tree` navigation is blocked while descendants are live so late events cannot land on a different branch.

Model-facing child output is capped at 50 KB / 2000 lines. Full transcripts remain in child session files.

## Workflow prompts

- `/implement <task>`: scout → planner → worker.
- `/scout-and-plan <task>`: scout → planner, without implementation.
- `/implement-and-review <task>`: worker → reviewer → original worker if fixes are needed.

These workflows wait for settlement notices and pass results explicitly; they do not use the old example's `chain` parameter.

## Current limitations

- Only local in-process Pi `AgentSession` children are supported.
- Children load built-in tools and explicit subagent tools, not arbitrary parent extension hooks or MCP composition. This prevents recursive extension loading and duplicate managers.
- Child model routes come from agent definitions or the caller; there is no model-discovery tool or route allowlist UI.
- Delegation limits are constants rather than a settings UI.
- There is no manual create button. Initial creation is model-driven; the UI manages existing children.
- Cross-process activation, durable parent mailboxes, and structured-output capture are out of scope.

## Tests

From `packages/coding-agent/`:

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/subagent-enhanced-manager.test.ts \
  test/subagent-enhanced-tools.test.ts \
  test/subagent-enhanced-session.test.ts
```

Tests use fake child sessions and the faux/provider test boundaries, never real provider APIs.

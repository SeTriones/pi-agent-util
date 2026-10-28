# Subagent Extension Implementation Plan

Status: **implemented for review — extension code and focused tests are complete**

## 1. Deliverable and location

Implement a separate multi-file example at:

- `packages/coding-agent/examples/extensions/subagent_enhanced/`
- Tests under `packages/coding-agent/test/`
- Documentation and sample agent/workflow files in the same example directory

The existing `packages/coding-agent/examples/extensions/subagent/` example is unchanged. After verification, the new extension can be symlinked into `~/.pi/agent/extensions/subagent_enhanced/` using the installation commands in its README. No Pi core changes were made.

The implementation uses Pi's public extension and SDK APIs, principally:

- `pi.registerTool()`, `pi.registerCommand()`, `pi.sendMessage()`, and `pi.appendEntry()`
- `createAgentSession()`, `SessionManager`, `DefaultResourceLoader`, and `ModelRuntime`
- `AgentSession.prompt()`, `steer()`, `followUp()`, `abort()`, `waitForIdle()`, `subscribe()`, and `dispose()`
- `ctx.ui.custom()`, `ctx.ui.setStatus()`, and the injected TUI keybinding manager

References reviewed:

- Pi extension, SDK, TUI, keybinding, and session-format documentation
- Pi's current foreground subprocess example in `examples/extensions/subagent/`
- DeepSeek Harness's subagent service, delegation/control tools, in-process spawn provider, UI documentation, and supplied chat history

## 2. Current behavior and target behavior

Pi's current example waits for each child to finish before returning its tool result. It supports single, parallel, and chain modes, but has no durable child catalog, follow-up messaging, cold resume, or manager UI.

DeepSeek Harness instead separates:

1. A **durable child session**, which retains identity and transcript after a run ends.
2. A **live activation**, which owns one period of execution and is released when the child and its descendants become idle.

That separation is necessary for `send_message` to resume the same child after completion. The Pi implementation adopts this model rather than keeping only a running/done flag.

## 3. Goals

### Model-triggered delegation

- Register `subagent` for a fresh, isolated child context.
- Register `subagent_fork` for a child seeded with the parent's completed conversation prefix, excluding the current in-flight turn.
- Return a child ID as soon as startup and initial-message admission succeed; do not wait for the final answer.
- Allow independent delegations through parallel model tool calls.
- Deliver final results automatically through parent completion notices; no polling is required.
- Preserve the existing Markdown agent definitions and user/project agent trust checks.

### Continuation and control tools

- `send_message`: message a direct child, or let a child message its direct parent.
- `interrupt_agent`: stop a running descendant's current work without deleting its session.
- `list_agents`: list direct children or the descendant tree with `running`/`inactive` status.
- Resume an inactive child under the same session ID when it receives another message.
- Support nested local children, subject to depth and active-agent limits.

### TUI manager

- Add `/subagents` to browse and control existing children.
- Show a live tree, statuses, labels, models, elapsed time, usage, and recent activity.
- Open a child's transcript, send follow-ups, and stop current work.
- Show a compact running/total count in Pi's footer status.
- Do not add a manual "create subagent" button; initial creation remains model-driven, as in DeepSeek Harness.

### Persistence and cleanup

- Keep child transcripts in normal Pi session files.
- Persist parent-owned catalog records outside model context.
- Restore catalogs after reload/resume and cold-resume children on demand.
- Abort and dispose live descendants child-first on session shutdown/replacement.

## 4. Non-goals for this iteration

- Codex, Claude Code, ACP, or other external subagent providers.
- A provider-registry abstraction for external backends; only local Pi `AgentSession` children are needed.
- Arbitrary model-route discovery or `list_subagent_models`; child model selection comes from the agent definition or the caller's current model.
- Structured-output captures, workflow-script orchestration, and web/desktop UI parity.
- A settings editor for delegation policy. Initial limits are constants: depth `1`, active descendants `8`, and 50 KB model-facing result truncation.
- Backward compatibility for the older example's `tasks` and `chain` tool parameters. The new extension uses parallel model calls instead of `tasks`; its sample workflow prompts use sequential completion-driven delegation instead of `chain`.

## 5. Model-facing interface

### `subagent`

Parameters:

- `agent`: optional agent definition name; default to a general worker.
- `description`: short display label.
- `prompt`: complete, self-contained task.
- `cwd`: optional child working directory, resolved against the caller's cwd.

Behavior:

1. Validate the agent, project-agent trust, depth, capacity, and cwd.
2. Create a fresh persistent child session with no parent conversation messages.
3. Append the parent-owned catalog record.
4. Admit the initial prompt and return `started subagent <id>` immediately.
5. Deliver the terminal result later in a `subagent-settled` custom message.

### `subagent_fork`

Uses the same parameters and lifecycle, but seeds the child from a snapshot of the parent's active branch before the current delegation turn. Later parent messages are not synchronized automatically. For an ephemeral parent, copy the projected completed messages into the new persistent child session.

### Control behavior

- A running child receives a follow-up with `steer`; an inactive child starts/resumes a run.
- A child-to-parent message uses steering while the parent is busy and triggers a turn when idle.
- Settlement notices use follow-up delivery while the parent is busy and trigger a turn when idle.
- `send_message` returns acceptance plus a manager-generated message ID, not the recipient's reply.
- `list_agents({ scope: "children" | "descendants" })` exposes activity only; detailed outcome remains in the UI and settlement notices.
- Only direct parent/child messaging is allowed. Interruption is allowed along the caller's descendant tree. Unknown IDs, siblings, and stale/non-adjacent callers are rejected.

Tool descriptions and prompt guidelines will explicitly say:

- Independent delegations should be started together.
- The parent should continue useful work while children run.
- When only waiting remains, the parent should end its turn instead of sleeping or polling.
- At the depth cap, the model should do the work directly; runtime enforcement still rejects attempted delegation.

## 6. Runtime architecture

```text
Parent model tool call
  -> delegation tool
    -> SubagentManager
      -> local ChildSessionFactory
        -> AgentSession + persistent SessionManager
      -> child ID returned
    -> child runs independently
      -> child control tools / nested children
      -> activation settles after child and descendants are idle
      -> runtime disposed, durable session retained
      -> parent completion notice

/subagents -> read-only manager projection + control commands -> SubagentManager
```

### Modules

| File | Responsibility |
|---|---|
| `index.ts` | Extension registration, root adapter, session lifecycle, status, and command wiring |
| `agents.ts` | Retain and test agent discovery/frontmatter parsing |
| `types.ts` | Agent config, durable records, activation state, stop reasons, and backend interfaces |
| `manager.ts` | Catalog, ownership, capacity, activation generations, messaging, resume, settlement, and shutdown |
| `session.ts` | Production `AgentSession` creation, model/auth setup, fork seeding, and child-scoped tools |
| `tools.ts` | Delegation/control schemas, execution adapters, and compact tool renderers |
| `messages.ts` | Agent-message and settlement formatting, output extraction, and truncation |
| `ui.ts` | `/subagents` custom TUI screen and live invalidation |
| `render.ts` | Reused progress, tool-call, token, cost, and duration formatting |

The session backend is injectable. Production uses real `AgentSession` objects; tests use fake sessions or the faux provider. This prevents tests from calling real paid APIs and keeps lifecycle logic independent of the TUI.

### Child construction

- Use `createAgentSession()` with a persistent `SessionManager` and the selected model/thinking level.
- Use the normal configured auth/model catalog. Mirror extension-registered provider definitions into the child `ModelRuntime` where necessary; do not read or persist API keys directly.
- Use `DefaultResourceLoader` with `noExtensions: true` and explicit `customTools` for child delegation/control. This prevents recursive loading of the subagent extension and duplicate managers.
- Append the selected agent's system prompt plus delegation instructions, parent ID, and depth guidance.
- Honor the agent definition's tool allowlist when present.

Consequence: children receive built-in tools and the explicit subagent tools, not arbitrary parent extension hooks/MCP composition in this iteration. This avoids recursive extension side effects and will be documented as a limitation.

## 7. Durable state and activation state

A versioned catalog record will contain approximately:

- Durable `id`, `parentId`, `label`, `agent`, `mode`, `cwd`, `depth`, and `sessionFile`
- Model/thinking selection needed for resume
- Latest activation generation and detailed UI status
- Created/updated timestamps, stop reason, safe diagnostic, final-output preview, and aggregate usage

Statuses:

- Live: `starting`, `running`, `stopping`
- Inactive: `completed`, `failed`, `aborted`, `interrupted`
- Model-facing projection: live -> `running`; every inactive state -> `inactive`

Each live activation additionally holds the `AgentSession`, subscription, prompt/abort promises, and a monotonically increasing generation. Late events from an old generation must not overwrite a newer resume.

Persistence rules:

- Parent catalog updates use `pi.appendEntry()` for the root session or `SessionManager.appendCustomEntry()` for a child session.
- Store creation and terminal/follow-up snapshots, not every streaming delta.
- Reconstruct the latest record per child from the active branch on `session_start` and `session_tree`.
- A child session also stores its own descriptor so resume does not depend on a live parent runtime.
- Catalog entries never enter model context; settlement and explicit agent messages do.
- Missing/corrupt child files remain visible with a diagnostic and cannot be resumed.

## 8. Lifecycle details

### Startup and admission

- Validate before allocating runtime resources.
- Reserve capacity before async creation.
- Use prompt preflight/admission to distinguish "started" from "finished".
- The delegation tool's abort signal covers startup/admission only. After admission, normal parent aborts do not implicitly kill the child; explicit interruption or tree shutdown does.
- Roll back partial resources and catalog/reservation state on startup failure.

### Natural settlement

An activation is not complete merely because `prompt()` resolved. Before settlement:

1. Wait for the child's current run to become idle.
2. Wait for active descendants and pending admissions.
3. Re-check idle/pending state because completion notices may start another child turn.
4. Capture final text, stop reason, safe error, and usage.
5. Persist the terminal catalog snapshot and release the live session/subscriptions.
6. Release capacity and notify the parent exactly once for that activation.

This prevents a parent child from being disposed while its own children are still running.

### Follow-up and cold resume

- Reuse a live child when present; otherwise reopen its `SessionManager` from `sessionFile` and recreate its session with the stored descriptor.
- Keep the durable child ID unchanged and start a new activation generation.
- Do not persist the old activation's abort signal, stream state, or subscriptions.
- A descendant whose direct parent is unavailable remains discoverable/read-only until the parent can be resumed.

### Interruption and shutdown

- `interrupt_agent` issues abort without waiting for quiescence and preserves the session for follow-ups.
- On root `session_shutdown`, reject new admissions, cancel descendants child-first, await cleanup, unsubscribe, and dispose sessions.
- Mark restored previously-live records as interrupted rather than pretending they are still running.
- Block `/tree` navigation while live descendants exist so late events cannot be written onto a different parent branch; allow it again after settlement. New/resume/fork/reload follow the normal shutdown path.

## 9. TUI manager design

`/subagents` will use `ctx.ui.custom()` and real TUI components rather than a second renderer.

### Catalog view

- Direct children initially; lazy-expand descendants.
- Rows show status, label, agent/mode, model, elapsed time, usage, and latest activity.
- Running counts and row content update from manager events.
- Empty, loading, missing-file, failed, interrupted, and completed states are distinct in the UI.

### Detail view and actions

- Read the live `AgentSession.messages` transcript or the persisted child session when inactive.
- Show user/assistant text, compact tool activity, final output, errors, and usage.
- Action menu: send follow-up, choose steer/follow-up when running, stop current work, back/close.
- Follow-up input uses `ctx.ui.editor()`; stop does not delete the child or its transcript.
- Navigation uses injected `tui.select.*` keybindings. No new hardcoded application shortcuts; `/subagents` is the entry point.
- Cache rendering by content/width, invalidate on manager changes, call `tui.requestRender()`, and truncate with Pi's width utilities.
- TUI is optional: model tools still work in print/JSON/RPC modes; the custom manager is guarded with `ctx.mode === "tui"`.

## 10. Documentation updates

- Rewrite the example README around async delegation, control tools, `/subagents`, lifecycle, persistence, and limitations.
- Retain the sample agent definitions, updating guidance for parent messaging where useful.
- Rewrite `implement`, `scout-and-plan`, and `implement-and-review` prompts to wait for each completion notice and pass the previous result explicitly; remove references to `chain` and `{previous}`.
- Document user-only agent scope by default and the existing confirmation behavior for untrusted project agents.

## 11. Tests

New/updated tests will use the suite harness, fake child sessions, or the faux provider only.

### Manager and tools

- Spawn returns before a deferred child result and sends exactly one settlement notice.
- Fresh spawn has no parent messages; fork contains only the completed prefix.
- Parallel starts, capacity rejection, depth rejection, and reservation release.
- Running follow-up steers; inactive follow-up cold-resumes the same ID.
- Child-to-parent relay, direct-adjacency enforcement, and sibling/unknown-target rejection.
- Interrupt is non-blocking and the child remains resumable.
- Parent settlement waits for grandchildren; shutdown is child-first.
- Provider failure, empty output, abort, startup rollback, stale-generation events, and output truncation.
- Catalog reconstruction, branch isolation, missing/corrupt sessions, and reload recovery.
- Existing project-agent trusted/untrusted behavior remains covered.

### UI

- Catalog projection, expand/collapse, status/usage formatting, detail rendering, and action dispatch with a fake manager.
- Injected keybindings, narrow widths, long labels/output, resize invalidation, and no UI calls in non-TUI modes.

### Verification commands

- Run each new/changed Vitest file directly with the repository's pinned Vitest CLI.
- Run `npm run check` after code changes and fix all reported issues.
- For the final interactive smoke test, load the interactive-testing skill and use controlled tmux with scripted/faux responses: create two children, inspect `/subagents`, send a follow-up, stop/resume, reload, and verify cleanup. No real provider APIs or keys.

## 12. Implementation status

Completed:

1. Added types, durable records, backend interfaces, and agent discovery.
2. Implemented production child creation and fresh/fork session seeding.
3. Implemented manager startup, activation generations, settlement, and persistence.
4. Added delegation/control tools and completion/relay messages.
5. Added cold resume, nested settlement, capacity/depth enforcement, and shutdown.
6. Added `/subagents`, footer status, and tool/result rendering.
7. Updated sample agents, workflow prompts, and README.
8. Added and ran focused manager and tool tests.

Verification so far:

- `subagent-enhanced-manager.test.ts`: 9 tests passed.
- `subagent-enhanced-tools.test.ts`: 4 tests passed.
- `subagent-enhanced-session.test.ts`: 4 tests passed.
- TypeScript reports no errors in the extension or its tests.
- Repository-wide `npm run check` reaches unrelated model-catalog errors because the checkout lacks gitignored generated model data; those errors are outside this extension.
- Runtime load smoke passed with the installed Pi 1.4.0 binary.
- Controlled tmux smoke passed for extension startup and the empty `/subagents` state. Full model-driven TUI testing remains pending review; no real provider calls were made.

## 13. Acceptance criteria

- A model can start fresh and forked local children and receive an immediate ID followed by automatic results.
- The parent never needs to poll; independent children can run concurrently.
- Parent/child messaging, descendant interruption, and direct/descendant listing enforce ownership rules.
- An inactive child can be resumed with the same ID and transcript after reload.
- `/subagents` provides live tree browsing, transcript inspection, follow-up, and stop controls without owning runtime lifecycle itself.
- Depth/capacity limits, trust checks, output bounds, branch isolation, and child-first cleanup hold under failure and cancellation.
- All focused tests pass without real provider calls, and the extension introduces no TypeScript errors. Repository-wide generated-model-data issues are documented separately.

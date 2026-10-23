---
description: Show the current model, provider, and thinking level
argument-hint: "[extra]"
---
Report the current Pi session state. Do not guess from your system prompt — read the live values from the shell tool environment.

Run exactly one bash command:

```bash
printf 'provider: %s\nmodel:    %s\nthinking: %s\n' "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"
printf 'session:  %s\n' "$PI_SESSION_ID"
```

Then reply with a compact table:

| Field | Value |
|---|---|
| Provider | the `$PI_PROVIDER` value |
| Model | the `$PI_MODEL` value |
| Thinking level | the `$PI_REASONING_LEVEL` value |
| Session | the `$PI_SESSION_ID` value, or "ephemeral" if empty |

Rules:
- Use the literal values you read back. Never substitute what you believe you are.
- If a variable is empty or unset, write `(unset)` rather than inventing a value.
- Add one short note if the thinking level is `off` or if the model has no reasoning support.

${1:+Additional detail requested: ${@}}

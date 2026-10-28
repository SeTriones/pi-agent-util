---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Run a sequential planning workflow for: $@

1. Start a fresh `scout` subagent to find relevant code. End your turn and wait for its completion notice instead of polling.
2. Start a fresh `planner` subagent with the original request and the scout's complete findings.
3. Return the resulting plan. Do not implement it.

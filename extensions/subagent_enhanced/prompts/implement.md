---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Run a sequential subagent workflow for: $@

1. Start a fresh `scout` subagent to find all relevant code. End your turn and wait for its completion notice instead of polling.
2. Start a fresh `planner` subagent. Give it the original request and the scout's complete findings, then wait for its plan.
3. Start a `worker` subagent with the original request, the plan, and any relevant findings. Ask it to implement and test the changes.
4. Report the worker's result and any remaining issues.

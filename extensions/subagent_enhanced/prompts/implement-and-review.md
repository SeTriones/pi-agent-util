---
description: Worker implements, reviewer reviews, worker applies feedback
---
Run a sequential implementation and review workflow for: $@

1. Start a `worker` subagent to implement and test the request. Wait for its completion notice.
2. Start a `reviewer` subagent with the original request and the worker's result. Ask it to inspect the actual changes. Wait for its review.
3. If the reviewer found actionable issues, resume the original worker with `send_message`, include the complete review, and ask it to fix and retest them. Otherwise, skip this step.
4. Report the final result, review outcome, and residual risks.

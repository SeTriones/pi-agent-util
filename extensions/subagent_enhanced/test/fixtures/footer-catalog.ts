import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const rootId = ctx.sessionManager.getSessionId();
		const status = process.env.SUBAGENT_FIXTURE_STATUS === "running" ? "running" : "completed";
		for (const id of ["child-1", "child-2"]) {
			pi.appendEntry("subagent-enhanced-catalog", {
				version: 1,
				id,
				parentId: rootId,
				label: id,
				mode: "spawn",
				depth: 1,
				cwd: ctx.cwd,
				agent: {
					name: "worker",
					description: "Worker",
					systemPrompt: "Work",
					source: "user",
					filePath: "/tmp/worker.md",
				},
				status,
				activation: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: 0,
				},
			});
		}
	});
}

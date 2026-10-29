import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../../manager.ts";
import type { RootSessionAdapter, SubagentRecord } from "../../types.ts";
import { openSubagentManager } from "../../ui.ts";

function record(rootId: string, index: number, parentId = rootId, depth = 1): SubagentRecord {
	return {
		version: 1,
		id: depth === 1 ? `child-${index}` : `nested-${index}`,
		parentId,
		label: depth === 1 ? `Task ${index}` : `Nested ${index}`,
		mode: "spawn",
		depth,
		cwd: "/tmp",
		agent: { name: "worker", description: "Test worker", systemPrompt: "Work", source: "user", filePath: "/tmp/worker.md" },
		model: { provider: "faux", id: "model" },
		status: "running",
		activation: 1,
		createdAt: Date.now() - 10000,
		updatedAt: Date.now(),
		startedAt: Date.now() - 9000,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.01 },
	};
}

function entry(record: SubagentRecord, index: number): SessionEntry {
	return {
		type: "custom",
		customType: "subagent-enhanced-catalog",
		data: record,
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date().toISOString(),
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const rootId = ctx.sessionManager.getSessionId();
		const records = Array.from({ length: 12 }, (_, index) => record(rootId, index + 1));
		records.push(record(rootId, 1, "child-1", 2), record(rootId, 2, "child-1", 2));
		const root: RootSessionAdapter = {
			id: rootId,
			cwd: ctx.cwd,
			isBusy: () => false,
			hasPendingMessages: () => false,
			appendCatalog: () => undefined,
			send: async () => undefined,
		};
		const manager = new SubagentManager(root, {
			create: () => Promise.reject(new Error("not implemented")),
			resume: () => Promise.reject(new Error("not implemented")),
		});
		const restore = () => manager.restore(records.map((item, index) => entry(item, index)));
		restore();
		let completed = 0;
		const timer = setInterval(() => {
			if (completed >= records.length) {
				clearInterval(timer);
				return;
			}
			records[completed].status = "completed";
			records[completed].stopReason = "completed";
			records[completed].endedAt = Date.now();
			restore();
			completed++;
		}, 500);
		pi.on("session_shutdown", () => clearInterval(timer));
		pi.registerCommand("subagents", {
			description: "Fixture manager",
			handler: async (_args, commandCtx) => openSubagentManager(manager, commandCtx),
		});
		ctx.ui.setStatus("subagent-enhanced", "fixture");
	});
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./manager.ts";
import { PiChildSessionFactory } from "./session.ts";
import { createSubagentTools } from "./tools.ts";
import { type RootSessionAdapter, SUBAGENT_CATALOG_ENTRY, type SubagentMessage } from "./types.ts";
import { openSubagentManager } from "./ui.ts";

export default function (pi: ExtensionAPI) {
	let manager: SubagentManager | undefined;
	let removeManagerListener: (() => void) | undefined;

	const requireManager = (): SubagentManager => {
		if (!manager) throw new Error("Subagent manager is not initialized");
		return manager;
	};

	const registerTools = (rootId: string) => {
		for (const tool of createSubagentTools(requireManager(), rootId)) pi.registerTool(tool);
	};

	pi.registerCommand("subagents", {
		description: "Browse, inspect, message, and stop subagents",
		handler: async (_args, ctx) => openSubagentManager(requireManager(), ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		const rootId = ctx.sessionManager.getSessionId();
		const send = async (message: SubagentMessage, deliverAs: "steer" | "followUp") => {
			pi.sendMessage(
				{
					customType: message.customType,
					content: message.content,
					display: message.display,
					details: message.details,
				},
				{ triggerTurn: true, deliverAs },
			);
		};
		const adapter: RootSessionAdapter = {
			id: rootId,
			cwd: ctx.cwd,
			isBusy: () => !ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
			appendCatalog: (record) => pi.appendEntry(SUBAGENT_CATALOG_ENTRY, record),
			send,
		};
		manager = new SubagentManager(
			adapter,
			new PiChildSessionFactory({
				modelRegistry: ctx.modelRegistry,
				createTools: (childId) => createSubagentTools(requireManager(), childId),
			}),
		);
		manager.restore(ctx.sessionManager.getBranch());
		registerTools(rootId);

		const updateStatus = (statusCtx: ExtensionContext) => {
			if (!statusCtx.hasUI) return;
			const snapshot = requireManager().snapshot();
			statusCtx.ui.setStatus(
				"subagent-enhanced",
				snapshot.total > 0 ? `subagents: ${snapshot.running} running / ${snapshot.total}` : undefined,
			);
		};
		removeManagerListener?.();
		removeManagerListener = manager.subscribe(() => updateStatus(ctx));
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		requireManager().restore(ctx.sessionManager.getBranch());
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		if (!manager?.hasLiveActivations()) return undefined;
		ctx.ui.notify("Wait for subagents to settle before navigating the session tree", "warning");
		return { cancel: true };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		removeManagerListener?.();
		removeManagerListener = undefined;
		if (manager) await manager.shutdown();
		manager = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("subagent-enhanced", undefined);
	});
}

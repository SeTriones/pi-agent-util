import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionToolContext,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import type { SubagentManager } from "./manager.ts";
import type { DelegationRequest, ForkSeed, ModelReference, SubagentMode } from "./types.ts";

const DelegationParameters = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent definition name. Default: worker." })),
	description: Type.String({ minLength: 1, description: "Short (3-5 word) task label for display." }),
	prompt: Type.String({ minLength: 1, description: "Complete task for the child agent." }),
	cwd: Type.Optional(Type.String({ description: "Child working directory; relative paths use the caller cwd." })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Agent directories to use. Default: "user". Project agents require trust or confirmation.',
			default: "user",
		}),
	),
	confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

const SendMessageParameters = Type.Object({
	agent_id: Type.String({ minLength: 1, description: "Direct child id, or direct parent id from a child." }),
	message: Type.String({ minLength: 1, description: "Message to deliver." }),
});
const InterruptParameters = Type.Object({
	agent_id: Type.String({ minLength: 1, description: "Running descendant agent id." }),
});
const ListParameters = Type.Object({
	scope: Type.Optional(
		StringEnum(["children", "descendants"] as const, {
			description: "children lists direct children (default); descendants lists the full tree.",
			default: "children",
		}),
	),
});

interface DelegationDetails {
	kind: "activation";
	subagentId: string;
	mode: SubagentMode;
}

function modelReference(model: Model<any>): ModelReference {
	return { provider: model.provider, id: model.id };
}

function resolveModel(reference: string, ctx: ExtensionToolContext): ModelReference {
	if (reference.includes("/")) {
		const separator = reference.indexOf("/");
		const provider = reference.slice(0, separator);
		const id = reference.slice(separator + 1);
		if (!ctx.modelRegistry.find(provider, id)) throw new Error(`Unknown model: ${reference}`);
		return { provider, id };
	}
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === reference);
	if (matches.length !== 1) {
		throw new Error(
			matches.length === 0
				? `Unknown model: ${reference}`
				: `Model id ${reference} is ambiguous; use provider/model.`,
		);
	}
	return modelReference(matches[0]);
}

function forkSeed(ctx: ExtensionToolContext): ForkSeed {
	const branch = ctx.sessionManager.getBranch();
	let cut = branch.length;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if ((entry.type === "message" && entry.message.role === "user") || entry.type === "custom_message") {
			cut = index;
			break;
		}
	}
	const entries = branch.slice(0, cut) as SessionEntry[];
	return {
		sourcePath: ctx.sessionManager.getSessionFile(),
		leafId: entries.at(-1)?.id,
		entries,
	};
}

async function prepareDelegation(
	params: Static<typeof DelegationParameters>,
	ctx: ExtensionToolContext,
	mode: SubagentMode,
): Promise<DelegationRequest> {
	const scope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(ctx.cwd, scope);
	const agentName = params.agent ?? "worker";
	const agent = discovery.agents.find((candidate) => candidate.name === agentName);
	if (!agent) {
		const available = formatAgentList(discovery.agents);
		throw new Error(`Unknown agent: ${agentName}. Available: ${available.text}`);
	}
	if (agent.source === "project" && (params.confirmProjectAgents ?? true) && ctx.hasUI && !ctx.isProjectTrusted()) {
		const confirmed = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Continue only for trusted repositories.`,
		);
		if (!confirmed) throw new Error("Canceled: project-local agent not approved.");
	}
	const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
	if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Child working directory does not exist or is not a directory: ${cwd}`);
	}
	return {
		label: params.description.trim(),
		prompt: params.prompt,
		cwd,
		agent,
		model: agent.model ? resolveModel(agent.model, ctx) : ctx.model ? modelReference(ctx.model) : undefined,
		thinkingLevel: agent.model ? undefined : ctx.thinkingLevel,
		seed: mode === "fork" ? forkSeed(ctx) : undefined,
	};
}

function delegationTool(manager: SubagentManager, callerId: string, mode: SubagentMode) {
	const name = mode === "spawn" ? "subagent" : "subagent_fork";
	return defineTool({
		name,
		label: mode === "spawn" ? "Subagent" : "Subagent Fork",
		description:
			mode === "spawn"
				? "Delegate a self-contained task to a fresh subagent in an isolated context. Returns its id immediately; a completion notice arrives later. Use send_message to steer or resume it."
				: "Delegate a task to a subagent seeded with this conversation's completed turns, excluding the current in-flight turn. Returns its id immediately; a completion notice arrives later.",
		promptSnippet: mode === "spawn" ? "Delegate independent work to a background subagent" : undefined,
		promptGuidelines: [
			`Use ${name} for focused work that benefits from a separate context; include all necessary context in the task.`,
			`Start independent delegations with ${name} together and continue useful work. When only waiting remains, end the turn instead of polling; completion notices start a new turn.`,
		],
		parameters: DelegationParameters,
		executionMode: "parallel",
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<{ content: [{ type: "text"; text: string }]; details: DelegationDetails }> {
			const request = await prepareDelegation(params, ctx, mode);
			const record = await manager.delegate(callerId, mode, request, signal);
			return {
				content: [{ type: "text", text: `started subagent ${record.id}` }],
				details: { kind: "activation", subagentId: record.id, mode },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("accent", args.description)}\n${theme.fg("dim", args.prompt)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as DelegationDetails | undefined;
			return new Text(
				details
					? `${theme.fg("success", "✓")} ${theme.fg("muted", "started")} ${theme.fg("accent", details.subagentId)}`
					: result.content[0]?.type === "text"
						? result.content[0].text
						: "(no output)",
				0,
				0,
			);
		},
	});
}

function controlTools(manager: SubagentManager, callerId: string): ToolDefinition[] {
	return [
		defineTool({
			name: "send_message",
			label: "Send Message",
			description:
				"Send a message to a direct child or your direct parent. A running target is steered; an inactive direct child is resumed. Returns acceptance, not the reply.",
			parameters: SendMessageParameters,
			async execute(_id, params) {
				const result = await manager.sendMessage(callerId, params.agent_id, params.message, { origin: "agent" });
				return {
					content: [{ type: "text" as const, text: `message delivered to agent ${params.agent_id}` }],
					details: result,
				};
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt Agent",
			description:
				"Ask a running descendant to stop its current work. Returns without waiting for quiescence. The durable child remains available for later messages.",
			parameters: InterruptParameters,
			async execute(_id, params) {
				await manager.interrupt(callerId, params.agent_id);
				return {
					content: [{ type: "text" as const, text: `interrupt requested for agent ${params.agent_id}` }],
					details: { accepted: true },
				};
			},
		}),
		defineTool({
			name: "list_agents",
			label: "List Agents",
			description:
				"List direct children or descendants with running/inactive status. Completion is delivered automatically; do not poll for results.",
			parameters: ListParameters,
			async execute(_id, params) {
				const entries = await manager.listAgents(callerId, params.scope ?? "children");
				const text = entries.length
					? entries
							.map(
								(entry) =>
									`${entry.id} [${entry.status}]${params.scope === "descendants" ? ` parent=${entry.parentId} depth=${entry.depth}` : ""} — ${entry.label}${entry.diagnostic ? ` [diagnostic: ${entry.diagnostic}]` : ""}`,
							)
							.join("\n")
					: "(no subagents)";
				return { content: [{ type: "text" as const, text }], details: { entries } };
			},
		}),
	];
}

export function createSubagentTools(manager: SubagentManager, callerId: string): ToolDefinition[] {
	return [
		delegationTool(manager, callerId, "spawn"),
		delegationTool(manager, callerId, "fork"),
		...controlTools(manager, callerId),
	];
}

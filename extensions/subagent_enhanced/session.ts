import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ChildSession, ChildSessionFactory, ForkSeed, SubagentRecord } from "./types.ts";

export interface PiChildSessionFactoryOptions {
	agentDir?: string;
	modelRegistry?: ModelRegistry;
	createTools: (childId: string) => ToolDefinition[];
}

const CHILD_TOOL_NAMES = ["subagent", "subagent_fork", "send_message", "interrupt_agent", "list_agents"];

function copySeedEntries(sessionManager: SessionManager, seed?: ForkSeed): void {
	for (const entry of seed?.entries ?? []) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "compactionSummary" || message.role === "branchSummary") {
				sessionManager.appendCustomMessageEntry(
					"subagent-enhanced-seed-summary",
					`Summary of earlier conversation:\n\n${message.summary}`,
					false,
				);
			} else if (message.role !== "system") {
				sessionManager.appendMessage(message);
			}
		} else if (entry.type === "custom_message") {
			sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			sessionManager.appendCustomMessageEntry(
				"subagent-enhanced-seed-summary",
				`Summary of earlier conversation:\n\n${entry.summary}`,
				false,
			);
		}
	}
}

function childGuidance(record: SubagentRecord): string {
	return [
		`You are delegated subagent ${record.id || "(pending session id)"}. Your permission scope is fixed by this child runtime.`,
		`Your direct parent agent id is ${record.parentId}. Use send_message for selected findings and your final result; the parent does not see your transcript automatically.`,
		`Your delegation depth is ${record.depth}. The configured maximum is enforced at runtime. If delegation is rejected at the depth cap, do the work directly.`,
		"Complete the delegated task autonomously and finish with a concise, self-contained result.",
	].join("\n\n");
}

export class PiChildSessionFactory implements ChildSessionFactory {
	private readonly agentDir: string;
	private runtimePromise?: Promise<ModelRuntime>;

	private readonly options: PiChildSessionFactoryOptions;

	constructor(options: PiChildSessionFactoryOptions) {
		this.options = options;
		this.agentDir = options.agentDir ?? getAgentDir();
	}

	private modelRuntime(): Promise<ModelRuntime> {
		this.runtimePromise ??= (async () => {
			const runtime = await ModelRuntime.create({
				authPath: join(this.agentDir, "auth.json"),
				modelsPath: join(this.agentDir, "models.json"),
			});
			const parentRegistry = this.options.modelRegistry;
			if (parentRegistry) {
				for (const providerId of parentRegistry.getRegisteredProviderIds()) {
					const nativeProvider = parentRegistry.getRegisteredNativeProvider(providerId);
					if (nativeProvider) runtime.registerNativeProvider(nativeProvider);
					const config = parentRegistry.getRegisteredProviderConfig(providerId);
					if (config) runtime.registerProvider(providerId, config);
				}
			}
			return runtime;
		})();
		return this.runtimePromise;
	}

	async create(record: SubagentRecord, seed?: ForkSeed): Promise<ChildSession> {
		let sessionManager: SessionManager;
		if (seed?.sourcePath && seed.leafId) {
			sessionManager = SessionManager.forkFrom(seed.sourcePath, record.cwd);
			sessionManager.branch(seed.leafId);
		} else {
			sessionManager = SessionManager.create(record.cwd);
			copySeedEntries(sessionManager, seed);
		}
		return this.establish(record, sessionManager);
	}

	async resume(record: SubagentRecord): Promise<ChildSession> {
		if (!record.sessionFile) throw new Error(`Subagent ${record.id} has no persisted session to resume`);
		return this.establish(record, SessionManager.open(record.sessionFile));
	}

	private async establish(record: SubagentRecord, sessionManager: SessionManager): Promise<ChildSession> {
		record.id = sessionManager.getSessionId();
		record.sessionFile = sessionManager.getSessionFile();
		const modelRuntime = await this.modelRuntime();
		const model = record.model ? modelRuntime.getModel(record.model.provider, record.model.id) : undefined;
		if (record.model && !model) throw new Error(`Unknown child model: ${record.model.provider}/${record.model.id}`);
		const settingsManager = SettingsManager.create(record.cwd, this.agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: record.cwd,
			agentDir: this.agentDir,
			settingsManager,
			noExtensions: true,
			appendSystemPrompt: [record.agent.systemPrompt, childGuidance(record)],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: record.cwd,
			agentDir: this.agentDir,
			modelRuntime,
			model,
			thinkingLevel: record.thinkingLevel,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: record.agent.tools ? [...record.agent.tools, ...CHILD_TOOL_NAMES] : undefined,
			customTools: this.options.createTools(sessionManager.getSessionId()),
		});
		await session.bindExtensions({ mode: "print" });
		return session;
	}
}

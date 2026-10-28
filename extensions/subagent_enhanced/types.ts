import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AgentSession,
	AgentSessionEvent,
	PromptOptions,
	SessionEntry,
	SessionManager,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export const SUBAGENT_CATALOG_ENTRY = "subagent-enhanced-catalog";
export const SUBAGENT_DESCRIPTOR_ENTRY = "subagent-enhanced-descriptor";
export const SUBAGENT_MESSAGE_TYPE = "subagent-enhanced-message";
export const SUBAGENT_SETTLED_TYPE = "subagent-enhanced-settled";

export type SubagentMode = "spawn" | "fork";
export type SubagentStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "aborted" | "interrupted";
export type SubagentStopReason = "completed" | "error" | "aborted" | "max-tokens";

export interface ModelReference {
	provider: string;
	id: string;
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface SubagentRecord {
	version: 1;
	id: string;
	parentId: string;
	label: string;
	mode: SubagentMode;
	depth: number;
	cwd: string;
	agent: AgentConfig;
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
	sessionFile?: string;
	status: SubagentStatus;
	activation: number;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	endedAt?: number;
	stopReason?: SubagentStopReason;
	error?: string;
	finalOutput?: string;
	usage: SubagentUsage;
}

export interface ForkSeed {
	sourcePath?: string;
	leafId?: string;
	entries: SessionEntry[];
}

export interface DelegationRequest {
	label: string;
	prompt: string;
	cwd: string;
	agent: AgentConfig;
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
	seed?: ForkSeed;
}

export interface SubagentMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

export interface RootSessionAdapter {
	readonly id: string;
	readonly cwd: string;
	isBusy(): boolean;
	hasPendingMessages(): boolean;
	appendCatalog(record: SubagentRecord): void;
	send(message: SubagentMessage, deliverAs: "steer" | "followUp"): Promise<void>;
}

export interface ChildSession {
	readonly sessionManager: SessionManager;
	readonly messages: AgentMessage[];
	readonly isStreaming: boolean;
	readonly isIdle: boolean;
	readonly pendingMessageCount: number;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	steer(text: string, images?: undefined, options?: { source?: "extension" }): Promise<unknown>;
	followUp(text: string, images?: undefined, options?: { source?: "extension" }): Promise<unknown>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	sendCustomMessage(
		message: Parameters<AgentSession["sendCustomMessage"]>[0],
		options?: Parameters<AgentSession["sendCustomMessage"]>[1],
	): Promise<void>;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	dispose(): void;
	getLastAssistantText(): string | undefined;
	getSessionStats(): SessionStats;
}

export interface ChildSessionFactory {
	create(record: SubagentRecord, seed?: ForkSeed): Promise<ChildSession>;
	resume(record: SubagentRecord): Promise<ChildSession>;
}

export interface SendMessageOptions {
	origin: "agent" | "human";
	delivery?: "steer" | "followUp";
}

export interface SubagentListEntry {
	id: string;
	parentId: string;
	label: string;
	depth: number;
	status: "running" | "inactive";
	diagnostic?: string;
}

export interface ManagerSnapshot {
	records: SubagentRecord[];
	running: number;
	total: number;
}

export function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

export function isLiveStatus(status: SubagentStatus): boolean {
	return status === "starting" || status === "running" || status === "stopping";
}

export function publicStatus(record: SubagentRecord): "running" | "inactive" {
	return isLiveStatus(record.status) ? "running" : "inactive";
}

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { capModelOutput, captureTerminalResult, createRelayMessage, createSettlementMessage } from "./messages.ts";
import { lastActivity } from "./render.ts";
import {
	type ChildSession,
	type ChildSessionFactory,
	type DelegationRequest,
	emptyUsage,
	isLiveStatus,
	type ManagerSnapshot,
	publicStatus,
	type RootSessionAdapter,
	type SendMessageOptions,
	SUBAGENT_CATALOG_ENTRY,
	SUBAGENT_DESCRIPTOR_ENTRY,
	type SubagentListEntry,
	type SubagentMode,
	type SubagentRecord,
} from "./types.ts";

interface Activation {
	session: ChildSession;
	generation: number;
	settled: Promise<void>;
	finishSettlement: () => void;
	settling: boolean;
	abortRequested: boolean;
	runError?: string;
	runPromise?: Promise<void>;
	unsubscribe: () => void;
}

interface ManagerOptions {
	maxDepth?: number;
	maxActive?: number;
	now?: () => number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cloneRecord(record: SubagentRecord): SubagentRecord {
	return structuredClone(record);
}

function isCatalogRecord(value: unknown): value is SubagentRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SubagentRecord>;
	return record.version === 1 && typeof record.id === "string" && typeof record.parentId === "string";
}

export class SubagentManager {
	private readonly records = new Map<string, SubagentRecord>();
	private readonly activations = new Map<string, Activation>();
	private readonly materializations = new Map<string, Promise<Activation>>();
	private readonly catalogLoaded = new Set<string>();
	private readonly catalogErrors = new Map<string, string>();
	private readonly listeners = new Set<() => void>();
	private readonly maxDepth: number;
	private readonly maxActive: number;
	private readonly now: () => number;
	private reserved = 0;
	private shuttingDown = false;

	private readonly root: RootSessionAdapter;
	private readonly factory: ChildSessionFactory;

	constructor(root: RootSessionAdapter, factory: ChildSessionFactory, options: ManagerOptions = {}) {
		this.root = root;
		this.factory = factory;
		this.maxDepth = options.maxDepth ?? 1;
		this.maxActive = options.maxActive ?? 8;
		this.now = options.now ?? Date.now;
	}

	get rootId(): string {
		return this.root.id;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	snapshot(): ManagerSnapshot {
		const records = [...this.records.values()].map(cloneRecord);
		return {
			records,
			running: records.filter((record) => isLiveStatus(record.status)).length,
			total: records.length,
		};
	}

	getRecord(id: string): SubagentRecord | undefined {
		const record = this.records.get(id);
		return record ? cloneRecord(record) : undefined;
	}

	childrenOf(parentId: string): SubagentRecord[] {
		return [...this.records.values()].filter((record) => record.parentId === parentId).map(cloneRecord);
	}

	activity(id: string): string | undefined {
		const activation = this.activations.get(id);
		if (activation) return lastActivity(activation.session.messages);
		return this.records.get(id)?.finalOutput;
	}

	hasLiveActivations(): boolean {
		return this.activations.size > 0 || this.materializations.size > 0;
	}

	restore(entries: SessionEntry[]): void {
		this.records.clear();
		this.catalogLoaded.clear();
		this.catalogErrors.clear();
		this.catalogLoaded.add(this.rootId);
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SUBAGENT_CATALOG_ENTRY || !isCatalogRecord(entry.data)) {
				continue;
			}
			if (entry.data.parentId === this.rootId) this.importRecord(entry.data);
		}
		this.emit();
	}

	private importRecord(input: SubagentRecord): void {
		const record = cloneRecord(input);
		if (isLiveStatus(record.status)) {
			record.status = "interrupted";
			record.endedAt = record.endedAt ?? this.now();
			record.updatedAt = this.now();
		}
		this.records.set(record.id, record);
	}

	private requireRecord(id: string): SubagentRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown subagent: ${id}`);
		return record;
	}

	private assertActiveCapacity(): void {
		if (this.activations.size + this.materializations.size + this.reserved >= this.maxActive) {
			throw new Error(
				`Subagent activation limit reached (${this.maxActive}). Wait for a child to finish or continue an existing agent.`,
			);
		}
	}

	private parentDepth(parentId: string): number {
		if (parentId === this.rootId) return 0;
		return this.requireRecord(parentId).depth;
	}

	async delegate(
		parentId: string,
		mode: SubagentMode,
		request: DelegationRequest,
		signal?: AbortSignal,
	): Promise<SubagentRecord> {
		if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
		if (parentId !== this.rootId) this.requireRecord(parentId);
		const depth = this.parentDepth(parentId) + 1;
		if (depth > this.maxDepth) {
			throw new Error(`Delegation depth ${depth} exceeds maximum ${this.maxDepth}; carry out the work directly.`);
		}
		this.assertActiveCapacity();
		signal?.throwIfAborted();
		this.reserved++;
		const timestamp = this.now();
		const record: SubagentRecord = {
			version: 1,
			id: "",
			parentId,
			label: request.label,
			mode,
			depth,
			cwd: request.cwd,
			agent: request.agent,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			status: "starting",
			activation: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
			usage: emptyUsage(),
		};
		let session: ChildSession | undefined;
		try {
			session = await this.factory.create(record, request.seed);
			signal?.throwIfAborted();
			record.id = session.sessionManager.getSessionId();
			record.sessionFile = session.sessionManager.getSessionFile();
			if (!record.id || this.records.has(record.id)) throw new Error(`Duplicate subagent session id: ${record.id}`);
			record.activation = 1;
			this.records.set(record.id, record);
			const activation = this.createActivation(record, session);
			session.sessionManager.appendCustomEntry(SUBAGENT_DESCRIPTOR_ENTRY, cloneRecord(record));
			this.persist(record);
			await this.startPrompt(record, activation, this.withParentGuidance(record, request.prompt), signal);
			return cloneRecord(record);
		} catch (error) {
			if (session) {
				try {
					session.dispose();
				} catch {
					// Startup cleanup is best effort; the original error is more useful.
				}
			}
			if (record.id && this.records.has(record.id)) {
				this.activations.get(record.id)?.unsubscribe();
				this.activations.delete(record.id);
				record.status = "failed";
				record.error = errorMessage(error);
				record.endedAt = this.now();
				this.persist(record);
			}
			throw error;
		} finally {
			this.reserved--;
			this.emit();
		}
	}

	private withParentGuidance(record: SubagentRecord, prompt: string): string {
		return `${prompt}\n\nYour parent agent id is ${JSON.stringify(record.parentId)}. Before you finish, send your result to that agent with send_message({ agent_id: ${JSON.stringify(record.parentId)}, message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.`;
	}

	private createActivation(record: SubagentRecord, session: ChildSession): Activation {
		let finishSettlement!: () => void;
		const settled = new Promise<void>((resolve) => {
			finishSettlement = resolve;
		});
		const activation: Activation = {
			session,
			generation: record.activation,
			settled,
			finishSettlement,
			settling: false,
			abortRequested: false,
			unsubscribe: () => undefined,
		};
		activation.unsubscribe = session.subscribe((event) => {
			if (this.activations.get(record.id) !== activation) return;
			if (
				event.type === "message_end" ||
				event.type === "tool_execution_end" ||
				event.type === "turn_end" ||
				event.type === "agent_settled"
			) {
				this.emit();
			}
			if (event.type === "agent_settled") void this.settle(record.id, activation);
		});
		this.activations.set(record.id, activation);
		return activation;
	}

	private async startPrompt(
		record: SubagentRecord,
		activation: Activation,
		prompt: string,
		signal?: AbortSignal,
	): Promise<void> {
		let admitted = false;
		let markAdmitted!: () => void;
		const admission = new Promise<void>((resolve) => {
			markAdmitted = resolve;
		});
		activation.runError = undefined;
		const runPromise = (async () => {
			try {
				await activation.session.prompt(prompt, {
					expandPromptTemplates: false,
					source: "extension",
					preflightResult: (disposition) => {
						if (disposition === "started") {
							admitted = true;
							markAdmitted();
						}
					},
				});
			} catch (error) {
				activation.runError = errorMessage(error);
			}
		})();
		activation.runPromise = runPromise;
		void runPromise.then(() => {
			markAdmitted();
			if (admitted) void this.settle(record.id, activation);
		});

		let abortListener: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			abortListener = () => {
				void activation.session.abort();
				reject(new Error("Subagent startup was aborted"));
			};
			if (signal?.aborted) abortListener();
			else signal?.addEventListener("abort", abortListener, { once: true });
		});
		try {
			await Promise.race([admission, runPromise, aborted]);
			if (!admitted) throw new Error(activation.runError ?? "Subagent ended before accepting its prompt");
			record.status = "running";
			record.startedAt = record.startedAt ?? this.now();
			record.endedAt = undefined;
			record.stopReason = undefined;
			record.error = undefined;
			this.persist(record);
		} finally {
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		}
	}

	private async ensureActivation(record: SubagentRecord): Promise<Activation> {
		const existing = this.activations.get(record.id);
		if (existing) {
			if (existing.settling) await existing.settled;
			else return existing;
		}
		const pending = this.materializations.get(record.id);
		if (pending) return pending;
		const materialization = this.materialize(record);
		this.materializations.set(record.id, materialization);
		try {
			return await materialization;
		} finally {
			this.materializations.delete(record.id);
		}
	}

	private async materialize(record: SubagentRecord): Promise<Activation> {
		if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
		this.assertActiveCapacity();
		this.reserved++;
		try {
			await this.loadCatalog(record.id);
			const session = await this.factory.resume(record);
			if (this.shuttingDown) {
				session.dispose();
				throw new Error("Subagent manager is shutting down");
			}
			record.sessionFile = session.sessionManager.getSessionFile() ?? record.sessionFile;
			record.activation++;
			record.status = "starting";
			record.updatedAt = this.now();
			const activation = this.createActivation(record, session);
			this.persist(record);
			return activation;
		} finally {
			this.reserved--;
			this.emit();
		}
	}

	async sendMessage(
		senderId: string,
		targetId: string,
		text: string,
		options: SendMessageOptions,
	): Promise<{ messageId: string }> {
		if (!text.trim()) throw new Error("Message cannot be empty");
		if (senderId === targetId) throw new Error("An agent cannot message itself");
		const messageId = randomUUID();
		const sender = senderId === this.rootId ? undefined : this.requireRecord(senderId);

		if (sender && sender.parentId === targetId) {
			if (!this.activations.has(senderId)) throw new Error("A child can message its parent only while it is active");
			await this.deliverCustom(targetId, createRelayMessage(senderId, targetId, text), "steer");
			return { messageId };
		}

		const target = this.requireRecord(targetId);
		if (target.parentId !== senderId) {
			throw new Error("Messages are restricted to a direct parent/child relationship");
		}
		const activation = await this.ensureActivation(target);
		const content = options.origin === "agent" ? `Agent ${senderId} sent a message:\n\n${text}` : text;
		if (activation.session.isStreaming) {
			if (options.delivery === "followUp") {
				await activation.session.followUp(content, undefined, { source: "extension" });
			} else {
				await activation.session.steer(content, undefined, { source: "extension" });
			}
		} else {
			try {
				await this.startPrompt(target, activation, content);
			} catch (error) {
				this.failActivation(target, activation, error);
				throw error;
			}
		}
		this.emit();
		return { messageId };
	}

	private async deliverCustom(
		targetId: string,
		message: Parameters<ChildSession["sendCustomMessage"]>[0],
		deliverAs: "steer" | "followUp",
	): Promise<void> {
		if (this.shuttingDown) return;
		if (targetId === this.rootId) {
			await this.root.send(
				{
					customType: message.customType,
					content: typeof message.content === "string" ? message.content : "",
					display: message.display,
					details: message.details,
				},
				deliverAs,
			);
			return;
		}
		const activation = this.activations.get(targetId);
		if (!activation) throw new Error(`Parent agent ${targetId} is not active`);
		await activation.session.sendCustomMessage(message, { triggerTurn: true, deliverAs });
	}

	private failActivation(record: SubagentRecord, activation: Activation, error: unknown): void {
		activation.runError = errorMessage(error);
		record.status = "failed";
		record.error = activation.runError;
		record.endedAt = this.now();
		try {
			this.persist(record);
		} catch {
			// Preserve the startup error if persistence also fails.
		}
		activation.unsubscribe();
		if (this.activations.get(record.id) === activation) this.activations.delete(record.id);
		activation.session.dispose();
		activation.finishSettlement();
		this.emit();
	}

	async interrupt(callerId: string, targetId: string): Promise<{ accepted: true }> {
		if (callerId !== this.rootId) this.requireRecord(callerId);
		const target = this.requireRecord(targetId);
		if (!this.isAncestor(callerId, target)) throw new Error("Only an ancestor can interrupt this agent");
		const activation = this.activations.get(targetId);
		if (!activation) return { accepted: true };
		activation.abortRequested = true;
		target.status = "stopping";
		target.updatedAt = this.now();
		this.persist(target);
		void activation.session
			.abort()
			.catch((error) => {
				activation.runError = errorMessage(error);
			})
			.finally(() => this.settle(targetId, activation));
		this.emit();
		return { accepted: true };
	}

	private isAncestor(callerId: string, target: SubagentRecord): boolean {
		let parentId = target.parentId;
		const seen = new Set<string>();
		while (parentId !== this.rootId) {
			if (seen.has(parentId)) return false;
			seen.add(parentId);
			const parent = this.records.get(parentId);
			if (!parent) return false;
			if (parent.id === callerId) return true;
			parentId = parent.parentId;
		}
		return callerId === this.rootId;
	}

	async listAgents(callerId: string, scope: "children" | "descendants"): Promise<SubagentListEntry[]> {
		if (callerId !== this.rootId) this.requireRecord(callerId);
		if (scope === "children") return this.listRows(callerId, this.childrenOf(callerId));
		const rows: SubagentRecord[] = [];
		const seen = new Set<string>();
		const visit = async (parentId: string) => {
			for (const child of this.childrenOf(parentId)) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				rows.push(child);
				await this.loadCatalog(child.id);
				await visit(child.id);
			}
		};
		await visit(callerId);
		return this.listRows(callerId, rows);
	}

	private listRows(rootId: string, records: SubagentRecord[]): SubagentListEntry[] {
		return records.map((record) => ({
			id: record.id,
			parentId: record.parentId,
			label: record.label,
			depth: rootId === record.parentId ? 1 : this.relativeDepth(rootId, record),
			status: publicStatus(record),
			diagnostic: this.catalogErrors.get(record.id),
		}));
	}

	private relativeDepth(rootId: string, record: SubagentRecord): number {
		if (rootId === this.rootId) return record.depth;
		const rootDepth = this.records.get(rootId)?.depth ?? 0;
		return Math.max(1, record.depth - rootDepth);
	}

	private persist(record: SubagentRecord): void {
		record.updatedAt = this.now();
		if (record.parentId === this.rootId) {
			this.root.appendCatalog(cloneRecord(record));
		} else {
			const parent = this.activations.get(record.parentId);
			if (!parent) throw new Error(`Cannot persist catalog for inactive parent ${record.parentId}`);
			parent.session.sessionManager.appendCustomEntry(SUBAGENT_CATALOG_ENTRY, cloneRecord(record));
		}
		this.emit();
	}

	private async settle(id: string, activation: Activation): Promise<void> {
		if (this.activations.get(id) !== activation || activation.settling) return activation.settled;
		activation.settling = true;
		void (async () => {
			const record = this.requireRecord(id);
			try {
				await activation.runPromise;
				while (true) {
					await activation.session.waitForIdle();
					const pendingMaterializations = [...this.materializations.entries()]
						.filter(([childId]) => this.records.get(childId)?.parentId === id)
						.map(([, promise]) => promise);
					if (pendingMaterializations.length > 0) await Promise.allSettled(pendingMaterializations);
					const descendants = [...this.activations.entries()]
						.filter(([childId]) => this.records.get(childId)?.parentId === id)
						.map(([, child]) => child.settled);
					if (descendants.length > 0) {
						await Promise.all(descendants);
						continue;
					}
					if (activation.session.isIdle && activation.session.pendingMessageCount === 0) break;
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				if (this.activations.get(id) !== activation) return;
				const result = captureTerminalResult(activation.session, activation.runError);
				record.stopReason = result.stopReason;
				record.status =
					result.stopReason === "completed" ? "completed" : result.stopReason === "aborted" ? "aborted" : "failed";
				record.error = result.error;
				record.finalOutput = result.output ? capModelOutput(result.output) : undefined;
				record.usage = result.usage;
				record.endedAt = this.now();
				this.persist(record);
				activation.unsubscribe();
				this.activations.delete(id);
				activation.session.dispose();
				this.emit();
				if (!this.shuttingDown) {
					try {
						await this.deliverCustom(record.parentId, createSettlementMessage(record), "followUp");
					} catch (error) {
						record.error = errorMessage(error);
					}
				}
			} catch (error) {
				record.status = "failed";
				record.error = errorMessage(error);
				record.endedAt = this.now();
				try {
					this.persist(record);
				} catch {
					// The parent may already be tearing down.
				}
				activation.unsubscribe();
				this.activations.delete(id);
				activation.session.dispose();
			} finally {
				activation.finishSettlement();
				this.emit();
			}
		})();
		return activation.settled;
	}

	async loadCatalog(id: string): Promise<void> {
		if (id === this.rootId || this.catalogLoaded.has(id)) return;
		const record = this.requireRecord(id);
		if (!record.sessionFile) {
			this.catalogErrors.set(id, "Child session file is unavailable");
			return;
		}
		try {
			const manager = SessionManager.open(record.sessionFile);
			for (const entry of manager.getBranch()) {
				if (entry.type !== "custom") continue;
				if (entry.customType === SUBAGENT_DESCRIPTOR_ENTRY && isCatalogRecord(entry.data)) {
					const descriptor = entry.data;
					record.agent = descriptor.agent;
					record.model = descriptor.model;
					record.thinkingLevel = descriptor.thinkingLevel;
					record.cwd = descriptor.cwd;
				}
				if (entry.customType === SUBAGENT_CATALOG_ENTRY && isCatalogRecord(entry.data)) {
					this.importRecord(entry.data);
				}
			}
			this.catalogLoaded.add(id);
			this.catalogErrors.delete(id);
		} catch (error) {
			this.catalogErrors.set(id, errorMessage(error));
		}
		this.emit();
	}

	async transcript(id: string): Promise<AgentMessage[]> {
		const activation = this.activations.get(id);
		if (activation) return [...activation.session.messages];
		const record = this.requireRecord(id);
		if (!record.sessionFile) throw new Error("Child session file is unavailable");
		return SessionManager.open(record.sessionFile).buildSessionProjection().messages;
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		await Promise.allSettled([...this.materializations.values()]);
		const pending = [...this.activations.entries()].sort(
			([left], [right]) => (this.records.get(right)?.depth ?? 0) - (this.records.get(left)?.depth ?? 0),
		);
		for (const [id, activation] of pending) {
			activation.abortRequested = true;
			const record = this.records.get(id);
			if (record) {
				record.status = "stopping";
				try {
					this.persist(record);
				} catch {
					// Continue child-first teardown even if a parent is unavailable.
				}
			}
			try {
				await activation.session.abort();
			} catch {
				// Dispose below is the final cleanup boundary.
			}
			await this.settle(id, activation);
		}
		this.activations.clear();
		this.emit();
	}
}

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import {
	type ChildSession,
	SUBAGENT_MESSAGE_TYPE,
	SUBAGENT_SETTLED_TYPE,
	type SubagentMessage,
	type SubagentRecord,
	type SubagentStopReason,
	type SubagentUsage,
} from "./types.ts";

const MAX_DIAGNOSTIC_BYTES = 4096;

function safeDiagnostic(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return truncateHead(value.trim(), { maxBytes: MAX_DIAGNOSTIC_BYTES, maxLines: 40 }).content;
}

export function capModelOutput(value: string): string {
	const truncated = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return value;
	return `${truncated.content}\n\n[Output truncated to ${DEFAULT_MAX_BYTES} bytes / ${DEFAULT_MAX_LINES} lines. The complete transcript remains in the child session.]`;
}

export function createRelayMessage(senderId: string, targetId: string, text: string): SubagentMessage {
	return {
		customType: SUBAGENT_MESSAGE_TYPE,
		content: `Agent ${senderId} sent a message to ${targetId}:\n\n${capModelOutput(text)}`,
		display: true,
		details: { senderId, targetId },
	};
}

export function createSettlementMessage(record: SubagentRecord): SubagentMessage {
	const subject = `Background subagent ${record.id} (${record.label})`;
	let summary: string;
	switch (record.stopReason) {
		case "completed":
			summary = `${subject} finished and will do no further work unless you send it more.`;
			break;
		case "aborted":
			summary = `${subject} was stopped before it finished.`;
			break;
		case "max-tokens":
			summary = `${subject} ran out of room before it finished.`;
			break;
		default:
			summary = `${subject} failed before it finished.`;
	}
	const parts = [summary];
	if (record.finalOutput) parts.push(`Its closing message:\n\n${capModelOutput(record.finalOutput)}`);
	else parts.push("It left no closing message.");
	if (record.error) parts.push(`Diagnostic: ${record.error}`);
	parts.push("Use send_message with this agent id to continue its conversation.");
	return {
		customType: SUBAGENT_SETTLED_TYPE,
		content: parts.join("\n\n"),
		display: true,
		details: { subagentId: record.id, parentId: record.parentId, status: record.status },
	};
}

function lastAssistant(session: ChildSession): AssistantMessage | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

export function captureTerminalResult(
	session: ChildSession,
	runError?: string,
): { output?: string; stopReason: SubagentStopReason; error?: string; usage: SubagentUsage } {
	const assistant = lastAssistant(session);
	const stats = session.getSessionStats();
	const usage: SubagentUsage = {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		total: stats.tokens.total,
		cost: stats.cost,
	};
	let stopReason: SubagentStopReason = "completed";
	if (runError || assistant?.stopReason === "error") stopReason = "error";
	else if (assistant?.stopReason === "aborted") stopReason = "aborted";
	else if (assistant?.stopReason === "length") stopReason = "max-tokens";
	return {
		output: session.getLastAssistantText(),
		stopReason,
		error: safeDiagnostic(runError) ?? safeDiagnostic(assistant?.errorMessage),
		usage,
	};
}

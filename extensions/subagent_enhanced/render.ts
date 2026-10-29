import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentRecord, SubagentUsage } from "./types.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: SubagentUsage): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

export function formatDuration(record: SubagentRecord, now = Date.now()): string {
	if (!record.startedAt) return "";
	const end = record.endedAt ?? now;
	const seconds = Math.max(0, Math.floor((end - record.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function statusGlyph(record: SubagentRecord): string {
	switch (record.status) {
		case "starting":
		case "running":
			return "●";
		case "stopping":
			return "◐";
		case "completed":
			return "✓";
		case "aborted":
		case "interrupted":
			return "■";
		case "failed":
			return "✗";
	}
}

export function lastActivity(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
				const part = message.content[partIndex];
				if (part.type === "text" && part.text.trim()) return part.text.trim();
				if (part.type === "toolCall") return `→ ${part.name}`;
			}
		}
		if (message.role === "toolResult") return `← ${message.toolName}`;
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.find((part) => part.type === "text")?.text;
			if (text) return text.trim();
		}
	}
	return "(no activity)";
}

export function messageText(message: AgentMessage): string {
	if (message.role === "assistant") {
		return message.content
			.map((part) => {
				if (part.type === "text") return part.text;
				if (part.type === "toolCall") return `→ ${part.name} ${JSON.stringify(part.arguments)}`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (message.role === "toolResult") {
		return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
	}
	if (message.role === "user" || message.role === "custom") {
		return typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
	}
	return "";
}

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentManager } from "./manager.ts";
import { formatDuration, formatTokens, formatUsage, messageText, statusGlyph } from "./render.ts";
import type { SubagentRecord } from "./types.ts";

interface Row {
	record: SubagentRecord;
	depth: number;
}

function visibleRows(manager: SubagentManager, expanded: ReadonlySet<string>): Row[] {
	const rows: Row[] = [];
	const seen = new Set<string>();
	const visit = (parentId: string, depth: number) => {
		for (const record of manager.childrenOf(parentId)) {
			if (seen.has(record.id)) continue;
			seen.add(record.id);
			rows.push({ record, depth });
			if (expanded.has(record.id)) visit(record.id, depth + 1);
		}
	};
	visit(manager.rootId, 1);
	return rows;
}

async function showTranscript(manager: SubagentManager, record: SubagentRecord, ctx: ExtensionCommandContext) {
	const messages = await manager.transcript(record.id);
	const lines: string[] = [`${record.label} · ${record.id}`, ""];
	for (const message of messages) {
		const text = messageText(message).trim();
		if (!text) continue;
		lines.push(`[${message.role}]`, text, "");
	}
	if (record.error) lines.push(`[error] ${record.error}`);
	let offset = Math.max(0, lines.length - 20);
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const invalidate = () => tui.requestRender();
		return {
			render(width: number): string[] {
				const page = lines.slice(offset, offset + 20);
				return [
					theme.fg(
						"accent",
						`${record.label} (${offset + 1}-${Math.min(lines.length, offset + 20)}/${lines.length})`,
					),
					...page,
					theme.fg("dim", "up/down scroll · pageUp/pageDown page · escape back"),
				].map((line) => truncateToWidth(line, width));
			},
			handleInput(data: string): void {
				if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
					done();
					return;
				}
				if (keybindings.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
				else if (keybindings.matches(data, "tui.select.down"))
					offset = Math.min(Math.max(0, lines.length - 20), offset + 1);
				else if (keybindings.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - 20);
				else if (keybindings.matches(data, "tui.select.pageDown")) {
					offset = Math.min(Math.max(0, lines.length - 20), offset + 20);
				} else return;
				invalidate();
			},
			invalidate,
		};
	});
}

async function showActions(
	manager: SubagentManager,
	record: SubagentRecord,
	expanded: Set<string>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const choices = [
		expanded.has(record.id) ? "Collapse descendants" : "Expand descendants",
		"View transcript",
		"Send follow-up",
		"Stop current work",
		"Back",
	];
	const action = await ctx.ui.select(`${record.label} · ${record.status}`, choices);
	if (!action || action === "Back") return;
	if (action === "View transcript") {
		await showTranscript(manager, record, ctx);
		return;
	}
	if (action === "Send follow-up") {
		const message = await ctx.ui.editor(`Message to ${record.label}`, "");
		if (!message?.trim()) return;
		let delivery: "steer" | "followUp" | undefined;
		if (record.status === "running" || record.status === "starting") {
			delivery = (await ctx.ui.select("Delivery", ["steer", "followUp"])) as "steer" | "followUp" | undefined;
			if (!delivery) return;
		}
		await manager.sendMessage(ctx.sessionManager.getSessionId(), record.id, message, { origin: "human", delivery });
		ctx.ui.notify(`Message sent to ${record.id}`, "info");
		return;
	}
	if (action === "Stop current work") {
		await manager.interrupt(ctx.sessionManager.getSessionId(), record.id);
		ctx.ui.notify(`Interrupt requested for ${record.id}`, "info");
		return;
	}
	if (expanded.has(record.id)) expanded.delete(record.id);
	else {
		await manager.loadCatalog(record.id);
		expanded.add(record.id);
	}
}

export async function openSubagentManager(manager: SubagentManager, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("subagents requires interactive TUI mode", "error");
		return;
	}
	const expanded = new Set<string>();
	let selectedIndex = 0;
	while (true) {
		let rows = visibleRows(manager, expanded);
		if (rows.length === 0) {
			ctx.ui.notify("No subagents in this session", "info");
			return;
		}
		selectedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));
		const unsubscribe = manager.subscribe(() => {
			rows = visibleRows(manager, expanded);
		});
		const selected = await ctx.ui.custom<SubagentRecord | undefined>((tui, theme, keybindings, done) => {
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			const invalidate = () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			};
			const refresh = () => {
				invalidate();
				tui.requestRender();
			};
			const unsubscribeRender = manager.subscribe(refresh);
			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					const snapshot = manager.snapshot();
					const output = [
						theme.fg("accent", theme.bold("Subagents")) +
							theme.fg("muted", ` · ${snapshot.running} running / ${snapshot.total} total`),
						"",
					];
					for (const [index, row] of rows.entries()) {
						const { record, depth } = row;
						const selectedPrefix = index === selectedIndex ? "> " : "  ";
						const indent = "  ".repeat(depth - 1);
						const usage = formatUsage(record.usage);
						const metrics = [
							record.model ? `${record.model.provider}/${record.model.id}` : record.agent.name,
							formatDuration(record),
							usage,
						]
							.filter(Boolean)
							.join(" · ");
						output.push(
							`${selectedPrefix}${indent}${statusGlyph(record)} ${record.label}`,
							`${selectedPrefix}${indent}  ${theme.fg("dim", `${record.id} · ${record.status} · ${metrics}`)}`,
						);
					}
					if (rows.length > 0) {
						const current = rows[Math.min(selectedIndex, rows.length - 1)].record;
						output.push(
							"",
							theme.fg("dim", `Latest: ${manager.activity(current.id) ?? current.agent.description}`),
						);
					}
					output.push("", theme.fg("dim", "up/down select · enter actions · escape close"));
					cachedWidth = width;
					cachedLines = output.map((line) => truncateToWidth(line, width));
					return cachedLines;
				},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.cancel")) {
						unsubscribeRender();
						done(undefined);
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						unsubscribeRender();
						done(rows[selectedIndex]?.record);
						return;
					}
					if (keybindings.matches(data, "tui.select.up")) {
						selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
					} else if (keybindings.matches(data, "tui.select.down")) {
						selectedIndex = (selectedIndex + 1) % rows.length;
					} else if (keybindings.matches(data, "tui.select.pageUp")) {
						selectedIndex = Math.max(0, selectedIndex - 10);
					} else if (keybindings.matches(data, "tui.select.pageDown")) {
						selectedIndex = Math.min(rows.length - 1, selectedIndex + 10);
					} else return;
					refresh();
				},
				invalidate,
			};
		});
		unsubscribe();
		if (!selected) return;
		await showActions(manager, selected, expanded, ctx);
	}
}

export function formatRecordSummary(record: SubagentRecord): string {
	return `${record.id} [${record.status}] ${record.label} · ${record.agent.name} · ${formatTokens(record.usage.total)} tokens`;
}

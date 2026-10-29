import { type ExtensionCommandContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
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
	while (true) {
		if (visibleRows(manager, expanded).length === 0) {
			ctx.ui.notify("No subagents in this session", "info");
			return;
		}
		const selected = await ctx.ui.custom<SubagentRecord | undefined>((tui, theme, keybindings, done) => {
			let rows = visibleRows(manager, expanded);
			let selectedId = rows[0]?.record.id;
			let list: SelectList;

			const rebuild = () => {
				rows = visibleRows(manager, expanded);
				if (!rows.some((row) => row.record.id === selectedId)) selectedId = rows[0]?.record.id;
				const items: SelectItem[] = rows.map(({ record, depth }) => {
					const usage = formatUsage(record.usage);
					const metrics = [
						record.model ? `${record.model.provider}/${record.model.id}` : record.agent.name,
						formatDuration(record),
						usage,
					]
						.filter(Boolean)
						.join(" · ");
					return {
						value: record.id,
						label: `${"  ".repeat(depth - 1)}${statusGlyph(record)} ${record.label}`,
						description: `${record.id} · ${record.status} · ${metrics}`,
					};
				});
				const maxVisible = Math.max(1, Math.min(10, tui.terminal.rows - 12));
				list = new SelectList(items, maxVisible, getSelectListTheme());
				if (selectedId) {
					list.setSelectedIndex(Math.max(0, rows.findIndex((row) => row.record.id === selectedId)));
				}
				list.onSelectionChange = (item) => {
					selectedId = item.value;
				};
				list.onSelect = (item) => {
					done(rows.find((row) => row.record.id === item.value)?.record);
				};
				list.onCancel = () => done(undefined);
			};
			rebuild();
			const unsubscribeRender = manager.subscribe(() => {
				rebuild();
				tui.requestRender();
			});
			return {
				render(width: number): string[] {
					const snapshot = manager.snapshot();
					const lines = [
						theme.fg("accent", theme.bold("Subagents")) +
							theme.fg("muted", ` · ${snapshot.running} running / ${snapshot.total} total`),
						"",
						...list.render(width),
					];
					const current = rows.find((row) => row.record.id === selectedId)?.record;
					if (current) {
						lines.push(
							"",
							theme.fg("dim", `Latest: ${manager.activity(current.id) ?? current.agent.description}`),
						);
					}
					lines.push("", theme.fg("dim", "up/down select · enter actions · escape close"));
					return lines.map((line) => truncateToWidth(line, width));
				},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.pageUp")) {
						list.setSelectedIndex(Math.max(0, rows.findIndex((row) => row.record.id === selectedId) - 10));
					} else if (keybindings.matches(data, "tui.select.pageDown")) {
						list.setSelectedIndex(
							Math.min(rows.length - 1, rows.findIndex((row) => row.record.id === selectedId) + 10),
						);
					} else {
						list.handleInput(data);
					}
					const current = list.getSelectedItem();
					if (current) selectedId = current.value;
					tui.requestRender();
				},
				invalidate: rebuild,
				dispose: unsubscribeRender,
			};
		});
		if (!selected) return;
		await showActions(manager, selected, expanded, ctx);
	}
}

export function formatRecordSummary(record: SubagentRecord): string {
	return `${record.id} [${record.status}] ${record.label} · ${record.agent.name} · ${formatTokens(record.usage.total)} tokens`;
}

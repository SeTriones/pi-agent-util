import { type ExtensionCommandContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentManager } from "./manager.ts";
import { formatDuration, formatTokens, formatUsage, messageText, statusGlyph } from "./render.ts";
import type { SubagentRecord } from "./types.ts";

interface Row {
	record: SubagentRecord;
	depth: number;
}

function singleLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
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
	const lines: string[] = [`${singleLine(record.label)} · ${record.id}`, ""];
	for (const message of messages) {
		const text = messageText(message).trim();
		if (!text) continue;
		lines.push(`[${message.role}]`, ...text.replace(/\r\n?/g, "\n").split("\n"), "");
	}
	if (record.error) lines.push(...`[error] ${record.error}`.replace(/\r\n?/g, "\n").split("\n"));
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const pageSize = () => Math.max(1, Math.min(20, tui.terminal.rows - 8));
		let offset = Math.max(0, lines.length - pageSize());
		const invalidate = () => tui.requestRender();
		return {
			render(width: number): string[] {
				offset = Math.min(offset, Math.max(0, lines.length - pageSize()));
				const page = lines.slice(offset, offset + pageSize());
				return [
					theme.fg(
						"accent",
						`${singleLine(record.label)} (${offset + 1}-${Math.min(lines.length, offset + pageSize())}/${lines.length})`,
					),
					...page,
					theme.fg("dim", "up/down scroll · pageUp/pageDown page · escape back"),
				].map((line) => truncateToWidth(line.replace(/\t/g, "   "), width));
			},
			handleInput(data: string): void {
				if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
					done();
					return;
				}
				if (keybindings.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
				else if (keybindings.matches(data, "tui.select.down"))
					offset = Math.min(Math.max(0, lines.length - pageSize()), offset + 1);
				else if (keybindings.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageSize());
				else if (keybindings.matches(data, "tui.select.pageDown")) {
					offset = Math.min(Math.max(0, lines.length - pageSize()), offset + pageSize());
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
	const action = await ctx.ui.select(`${singleLine(record.label)} · ${record.status}`, choices);
	if (!action || action === "Back") return;
	if (action === "View transcript") {
		await showTranscript(manager, record, ctx);
		return;
	}
	if (action === "Send follow-up") {
		const message = await ctx.ui.editor(`Message to ${singleLine(record.label)}`, "");
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
	let restoreClearOnShrink: (() => void) | undefined;
	try {
		while (true) {
			if (visibleRows(manager, expanded).length === 0) {
				ctx.ui.notify("No subagents in this session", "info");
				return;
			}
			const selected = await ctx.ui.custom<SubagentRecord | undefined>((tui, theme, keybindings, done) => {
				if (!restoreClearOnShrink) {
					const previous = tui.getClearOnShrink();
					restoreClearOnShrink = () => tui.setClearOnShrink(previous);
				}
				tui.setClearOnShrink(true);
				let rows = visibleRows(manager, expanded);
				let selectedId = rows[0]?.record.id;
				let list: SelectList;
				let terminalRows = tui.terminal.rows;

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
							label: `${"  ".repeat(depth - 1)}${statusGlyph(record)} ${singleLine(record.label)}`,
							description: singleLine(`${record.id} · ${record.status} · ${metrics}`),
						};
					});
					terminalRows = tui.terminal.rows;
					// Share the available height between the catalog and the output preview.
					const maxVisible = Math.max(1, Math.min(10, Math.floor((terminalRows - 12) / 2)));
					list = new SelectList(items, maxVisible, getSelectListTheme());
					if (selectedId) {
						list.setSelectedIndex(
							Math.max(
								0,
								rows.findIndex((row) => row.record.id === selectedId),
							),
						);
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
						if (terminalRows !== tui.terminal.rows) rebuild();
						const snapshot = manager.snapshot();
						const lines = [
							theme.fg("accent", theme.bold("Subagents")) +
								theme.fg("muted", ` · ${snapshot.running} running / ${snapshot.total} total`),
							"",
							...list.render(width),
						];
						const current = rows.find((row) => row.record.id === selectedId)?.record;
						// Reserve four rows for the preview heading/help, plus five for Pi's surrounding UI.
						const previewHeight = Math.max(0, Math.min(8, tui.terminal.rows - lines.length - 9));
						if (current && previewHeight > 0) {
							const output = manager.activity(current.id) ?? current.agent.description;
							// Wrapping returns one array entry per terminal row, including explicit blank lines.
							const outputLines = wrapTextWithAnsi(output.replace(/\t/g, "   "), Math.max(1, width));
							const preview = outputLines.slice(0, previewHeight);
							const heading =
								outputLines.length > preview.length
									? `Latest (${preview.length}/${outputLines.length} lines · enter → View transcript):`
									: "Latest:";
							lines.push("", theme.fg("dim", heading), ...preview.map((line) => theme.fg("dim", line)));
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
	} finally {
		restoreClearOnShrink?.();
	}
}

export function formatRecordSummary(record: SubagentRecord): string {
	return `${record.id} [${record.status}] ${record.label} · ${record.agent.name} · ${formatTokens(record.usage.total)} tokens`;
}

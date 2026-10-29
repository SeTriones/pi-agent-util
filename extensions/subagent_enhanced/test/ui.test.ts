import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SubagentManager } from "../manager.ts";
import { emptyUsage, type SubagentRecord } from "../types.ts";
import { openSubagentManager } from "../ui.ts";

initTheme("dark");

function record(index: number): SubagentRecord {
	return {
		version: 1,
		id: `child-${index}`,
		parentId: "root",
		label: `Task ${index}`,
		mode: "spawn",
		depth: 1,
		cwd: "/tmp",
		agent: {
			name: "worker",
			description: "Test worker",
			systemPrompt: "Work",
			source: "user",
			filePath: "/tmp/worker.md",
		},
		status: "completed",
		activation: 1,
		createdAt: 1,
		updatedAt: 1,
		usage: emptyUsage(),
	};
}

function managerWith(records: SubagentRecord[]) {
	const manager = new SubagentManager(
		{
			id: "root",
			cwd: "/tmp",
			isBusy: () => false,
			hasPendingMessages: () => false,
			appendCatalog: () => undefined,
			send: async () => undefined,
		},
		{
			create: async () => {
				throw new Error("Unexpected child creation");
			},
			resume: async () => {
				throw new Error("Unexpected child resume");
			},
		},
	);
	const update = () =>
		manager.restore(
			records.map((data, index) => ({
				type: "custom" as const,
				customType: "subagent-enhanced-catalog",
				data,
				id: `entry-${index}`,
				parentId: null,
				timestamp: new Date().toISOString(),
			})),
		);
	update();
	return { manager, update };
}

type DialogComponent = Component & { dispose?(): void };
type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];

function harness(terminalRows = 51) {
	let next = Promise.withResolvers<DialogComponent>();
	let clearOnShrink = false;
	let renders = 0;
	const terminal = { rows: terminalRows };
	const tui = {
		terminal,
		requestRender: () => {
			renders++;
		},
		getClearOnShrink: () => clearOnShrink,
		setClearOnShrink: (value: boolean) => {
			clearOnShrink = value;
		},
	};
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (factory: CustomFactory) => {
				const result = Promise.withResolvers<unknown>();
				const component = await factory(
					tui as unknown as Parameters<CustomFactory>[0],
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as Parameters<CustomFactory>[1],
					getKeybindings() as Parameters<CustomFactory>[2],
					result.resolve,
				);
				next.resolve(component);
				try {
					return await result.promise;
				} finally {
					component.dispose?.();
				}
			},
			select: async () => "View transcript",
			notify: () => {
				throw new Error("Unexpected notification");
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		terminal,
		get renders() {
			return renders;
		},
		get clearOnShrink() {
			return clearOnShrink;
		},
		async dialog() {
			const component = await next.promise;
			next = Promise.withResolvers<DialogComponent>();
			return component;
		},
	};
}

function rendered(component: Component, width: number): string[] {
	const lines = component.render(width);
	for (const line of lines) {
		assert.doesNotMatch(line, /[\r\n\t]/, "each render entry must occupy exactly one terminal row");
		assert.ok(visibleWidth(line) <= width, "rendered rows must fit the terminal width");
	}
	return lines.map(stripTerminalSequences);
}

test("completed multiline output stays in one row across selection changes and live updates", async () => {
	const records = [record(1), record(2)];
	records[0].finalOutput = "## Completed\r\nFound files\n\n## Files Changed\n- result.txt";
	records[1].agent.description = "General-purpose\rworker\nwith tools\tavailable";
	records[1].label = "Task\n2\rwith\ttabs";
	const { manager, update } = managerWith(records);
	const ui = harness();
	const closed = openSubagentManager(manager, ui.ctx);
	const component = await ui.dialog();
	for (let index = 0; index < 20; index++) {
		for (const width of [161, 80, 24]) {
			const lines = rendered(component, width);
			assert.equal(lines.length, 8);
			assert.equal(lines.filter((line) => line.startsWith("Subagents")).length, 1);
			if (width === 161) assert.equal(lines.filter((line) => line.includes("child-")).length, 2);
		}
		component.handleInput?.(index % 2 ? "\x1b[A" : "\x1b[B");
		records[0].finalOutput += "\nUpdate";
		update();
	}
	component.handleInput?.("\x1b");
	await closed;
	assert.equal(ui.clearOnShrink, false);
	const renderCount = ui.renders;
	update();
	assert.equal(ui.renders, renderCount, "closing the manager must remove its render subscription");
});

test("a large catalog remains bounded while navigating and resizing", async () => {
	const { manager } = managerWith(Array.from({ length: 30 }, (_, index) => record(index)));
	const ui = harness();
	const closed = openSubagentManager(manager, ui.ctx);
	const component = await ui.dialog();
	for (let index = 0; index < 40; index++) {
		const lines = rendered(component, 100);
		assert.equal(lines.filter((line) => line.includes("child-")).length, 10);
		assert.equal(lines.length, 17);
		component.handleInput?.("\x1b[B");
	}
	ui.terminal.rows = 16;
	component.invalidate();
	assert.equal(rendered(component, 40).length, 11);
	component.handleInput?.("\x1b");
	await closed;
});

test("transcripts split multiline messages and errors into independently scrollable rows", async () => {
	const child = record(1);
	child.error = "First error\r\nSecond error\rThird error";
	const { manager } = managerWith([child]);
	manager.transcript = async () => [{ role: "user", content: "alpha\r\n\tbeta\ngamma\rdelta", timestamp: 1 }];
	const ui = harness(16);
	const closed = openSubagentManager(manager, ui.ctx);
	const list = await ui.dialog();
	list.handleInput?.("\r");
	const transcript = await ui.dialog();
	let lines = rendered(transcript, 80);
	assert.ok(lines.includes("   beta"));
	assert.ok(lines.includes("Second error"));
	assert.ok(lines.includes("Third error"));
	assert.ok(lines.length <= 10);
	for (let index = 0; index < 20; index++) transcript.handleInput?.("\x1b[A");
	lines = rendered(transcript, 24);
	assert.ok(lines.includes("alpha"));
	assert.ok(lines.includes("gamma"));
	ui.terminal.rows = 12;
	assert.ok(rendered(transcript, 24).length <= 6);
	transcript.handleInput?.("\x1b");
	const reopened = await ui.dialog();
	rendered(reopened, 80);
	reopened.handleInput?.("\x1b");
	await closed;
});

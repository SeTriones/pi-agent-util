import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(fs.readFileSync(filePath, "utf8"));
			if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: parseToolList(frontmatter.tools),
				model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			// One malformed agent must not hide every other agent.
		}
	}
	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Keep walking toward the filesystem root.
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of scope === "user" ? userAgents : projectAgents) agentMap.set(agent.name, agent);
	}
	return { agents: [...agentMap.values()], projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems = 8): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	return {
		text: agents
			.slice(0, maxItems)
			.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`)
			.join("; "),
		remaining: Math.max(0, agents.length - maxItems),
	};
}

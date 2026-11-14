/**
 * 13-claude-rules.ts — Dynamic Rules & Skills Auto-Loader
 *
 * Automatically discovers and injects rules and skills without manual toggles:
 * - Rules: ~/.agent/rules/, ~/.pi/agent/rules/, <cwd>/.agent/rules/, <cwd>/.claude/rules/
 * - Extra Skills: ~/.agent/skills/, <cwd>/.agent/skills/ (deduped against ~/.pi/agent/skills/)
 *
 * Re-scans automatically with a short 2s cache so newly added or updated
 * rules/skills take effect immediately on the next turn without /reload.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME_DIR = os.homedir();
const MAX_INLINE_RULE_CHARS = 8000;
const CACHE_TTL_MS = 2000;

interface DiscoveredFile {
	label: string;
	absPath: string;
}

interface DiscoveredSkill {
	name: string;
	description: string;
	absPath: string;
}

function findMarkdownFiles(dir: string, prefixLabel: string, basePath = ""): DiscoveredFile[] {
	const results: DiscoveredFile[] = [];
	if (!fs.existsSync(dir)) return results;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const rel = basePath ? `${basePath}/${entry.name}` : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(full, prefixLabel, rel));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push({ label: `${prefixLabel}/${rel}`, absPath: full });
		}
	}
	return results;
}

function parseSkillFrontmatter(filePath: string, fallbackName: string): { name: string; description: string } {
	try {
		const raw = fs.readFileSync(filePath, "utf8").slice(0, 2000);
		const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fm) return { name: fallbackName, description: "Custom agent skill" };
		const block = fm[1];
		const nameMatch = block.match(/^name:\s*(.+)$/m);
		const descMatch = block.match(/^description:\s*(.+)$/m);
		const stripQuotes = (s: string) => s.trim().replace(/^["']|["']$/g, "");
		return {
			name: nameMatch ? stripQuotes(nameMatch[1]) : fallbackName,
			description: descMatch ? stripQuotes(descMatch[1]) : "Custom agent skill",
		};
	} catch {
		return { name: fallbackName, description: "Custom agent skill" };
	}
}

function discoverSkillsInDir(dir: string): DiscoveredSkill[] {
	const results: DiscoveredSkill[] = [];
	if (!fs.existsSync(dir)) return results;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const skillMd = path.join(dir, entry.name, "SKILL.md");
		if (!fs.existsSync(skillMd)) continue;
		const meta = parseSkillFrontmatter(skillMd, entry.name);
		results.push({ name: meta.name, description: meta.description, absPath: skillMd });
	}
	return results;
}

function collectContextRulesAndSkills(cwd: string): {
	rules: DiscoveredFile[];
	extraSkills: DiscoveredSkill[];
} {
	const rules: DiscoveredFile[] = [
		...findMarkdownFiles(path.join(HOME_DIR, ".agent", "rules"), "~/.agent/rules"),
		...findMarkdownFiles(path.join(HOME_DIR, ".pi", "agent", "rules"), "~/.pi/agent/rules"),
		...findMarkdownFiles(path.join(cwd, ".agent", "rules"), ".agent/rules"),
		...findMarkdownFiles(path.join(cwd, ".claude", "rules"), ".claude/rules"),
	];

	// Pi natively loads ~/.pi/agent/skills/ and <cwd>/.pi/skills/.
	// Collect skills from ~/.agent/skills/ and <cwd>/.agent/skills/ without duplicating Pi's built-in roots.
	const nativeSkillNames = new Set<string>();
	for (const nativeDir of [
		path.join(HOME_DIR, ".pi", "agent", "skills"),
		path.join(cwd, ".pi", "skills"),
	]) {
		for (const s of discoverSkillsInDir(nativeDir)) {
			nativeSkillNames.add(s.name);
		}
	}

	const extraSkillMap = new Map<string, DiscoveredSkill>();
	for (const extraDir of [
		path.join(HOME_DIR, ".agent", "skills"),
		path.join(cwd, ".agent", "skills"),
	]) {
		for (const s of discoverSkillsInDir(extraDir)) {
			if (!nativeSkillNames.has(s.name)) {
				extraSkillMap.set(s.name, s);
			}
		}
	}

	return { rules, extraSkills: [...extraSkillMap.values()] };
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
	let cachedCwd = "";
	let cachedAt = 0;
	let cachedPayload = "";
	let lastSummary = { rules: 0, extraSkills: 0 };

	function buildInjection(cwd: string): string {
		const now = Date.now();
		if (cwd === cachedCwd && now - cachedAt < CACHE_TTL_MS) {
			return cachedPayload;
		}

		const { rules, extraSkills } = collectContextRulesAndSkills(cwd);
		lastSummary = { rules: rules.length, extraSkills: extraSkills.length };

		const sections: string[] = [];

		if (rules.length > 0) {
			let remainingBudget = MAX_INLINE_RULE_CHARS;
			const inlined: string[] = [];
			const deferred: string[] = [];

			for (const r of rules) {
				let content = "";
				try {
					content = fs.readFileSync(r.absPath, "utf8").trim();
				} catch {
					content = "";
				}
				if (content && content.length <= remainingBudget) {
					inlined.push(`### Rule: ${r.label}\n${content}`);
					remainingBudget -= content.length;
				} else {
					deferred.push(`- ${r.label} (${r.absPath})`);
				}
			}

			const parts = [
				"## Active Agent Rules (Always Enforced)",
				"Follow all active rules below by default without waiting for the user to ask.",
			];
			if (inlined.length > 0) parts.push(inlined.join("\n\n"));
			if (deferred.length > 0) {
				parts.push(
					`Additional rule files (use \`read\` when working on related tasks):\n${deferred.join("\n")}`,
				);
			}
			sections.push(parts.join("\n\n"));
		}

		if (extraSkills.length > 0) {
			const skillLines = extraSkills.map(
				(s) => `- **${s.name}** (${s.absPath}): ${s.description}`,
			);
			sections.push(
				[
					"## Additional `.agent/skills` (Auto-Discovered)",
					"Whenever a task matches one of these skills, you MUST read its `SKILL.md` file first and follow it by default:",
					skillLines.join("\n"),
				].join("\n\n"),
			);
		}

		cachedCwd = cwd;
		cachedAt = now;
		cachedPayload = sections.length > 0 ? `\n\n${sections.join("\n\n")}\n` : "";
		return cachedPayload;
	}

	pi.on("session_start", async (_event, ctx) => {
		cachedAt = 0; // force fresh scan on session start
		buildInjection(ctx.cwd);
		if (ctx.hasUI && (lastSummary.rules > 0 || lastSummary.extraSkills > 0)) {
			ctx.ui.notify(
				`Loaded ${lastSummary.rules} rule(s), ${lastSummary.extraSkills} extra .agent skill(s)`,
				"info",
			);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const extra = buildInjection(ctx.cwd);
		if (!extra) return;
		return {
			systemPrompt: event.systemPrompt + extra,
		};
	});
}

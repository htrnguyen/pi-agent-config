/**
 * 15-auto-check.ts — Lightweight post-edit/write auto-checker for Pi.
 *
 * Replaces heavy LSP daemons with fast, silent-when-clean checks after `write` / `edit`:
 * - Python (.py): py_compile + ruff + ty / pyright (project .venv first, then global)
 * - TS/TSX (.ts, .tsx, .mts, .cts): project biome/eslint + tsc --noEmit (if tsconfig.json exists)
 * - JS/JSX (.js, .jsx, .mjs, .cjs): node --check + project biome/eslint
 * - Shell (.sh, .bash): bash -n + shellcheck (if installed)
 * - JSON (.json): in-process JSON.parse
 * - Ignores .md, .txt, .log, node_modules, .venv, .git
 *
 * Silent when clean. On errors, appends concise diagnostics directly to the tool result
 * so the agent self-corrects immediately in the same turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHECK_TIMEOUT_MS = 8000;
const MAX_LINES_PER_CHECK = 25;
const MAX_CHARS_TOTAL = 2400;

const IGNORED_PATH_PARTS = new Set([
	"node_modules",
	".git",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
]);

interface CheckIssue {
	tool: string;
	output: string;
}

const globalBinCache = new Map<string, string | null>();

function isExecutableFile(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function findGlobalBin(binName: string): string | null {
	if (globalBinCache.has(binName)) {
		return globalBinCache.get(binName) ?? null;
	}
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of pathDirs) {
		const candidate = path.join(dir, binName);
		if (isExecutableFile(candidate)) {
			globalBinCache.set(binName, candidate);
			return candidate;
		}
	}
	globalBinCache.set(binName, null);
	return null;
}

function findProjectBin(
	startDir: string,
	stopDir: string,
	binName: string,
	kind: "python" | "node",
): string | null {
	let dir = path.resolve(startDir);
	const root = path.resolve(stopDir);
	const relCandidates =
		kind === "python"
			? [path.join(".venv", "bin", binName), path.join("venv", "bin", binName)]
			: [path.join("node_modules", ".bin", binName)];

	while (true) {
		for (const rel of relCandidates) {
			const full = path.join(dir, rel);
			if (isExecutableFile(full)) return full;
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function resolveBin(
	fileDir: string,
	cwd: string,
	binName: string,
	kind?: "python" | "node",
): string | null {
	if (kind) {
		const local = findProjectBin(fileDir, cwd, binName, kind);
		if (local) return local;
	}
	return findGlobalBin(binName);
}

function findNearestFile(startDir: string, stopDir: string, fileName: string): string | null {
	let dir = path.resolve(startDir);
	const root = path.resolve(stopDir);
	while (true) {
		const candidate = path.join(dir, fileName);
		if (fs.existsSync(candidate)) return candidate;
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function shouldSkipPath(absPath: string): boolean {
	const parts = absPath.split(path.sep);
	return parts.some((p) => IGNORED_PATH_PARTS.has(p));
}

function formatCommandOutput(raw: string): string {
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0);
	if (lines.length <= MAX_LINES_PER_CHECK) return lines.join("\n");
	const head = lines.slice(0, MAX_LINES_PER_CHECK).join("\n");
	return `${head}\n... (+${lines.length - MAX_LINES_PER_CHECK} more lines)`;
}

async function runCheckCmd(
	pi: ExtensionAPI,
	toolLabel: string,
	cmd: string,
	args: string[],
	cwd: string,
): Promise<CheckIssue | null> {
	try {
		const res = await pi.exec(cmd, args, { cwd, timeout: CHECK_TIMEOUT_MS });
		if (res.code === 0) return null;
		const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
		if (!combined) return null;
		return { tool: toolLabel, output: formatCommandOutput(combined) };
	} catch {
		return null;
	}
}

async function checkPython(
	pi: ExtensionAPI,
	absPath: string,
	cwd: string,
): Promise<CheckIssue[]> {
	const issues: CheckIssue[] = [];
	const fileDir = path.dirname(absPath);
	const py = resolveBin(fileDir, cwd, "python3", "python") ?? "python3";

	const compileErr = await runCheckCmd(pi, "py_compile", py, ["-m", "py_compile", absPath], cwd);
	if (compileErr) {
		issues.push(compileErr);
		return issues; // Fix syntax errors before running lint/typecheck
	}

	const tasks: Promise<CheckIssue | null>[] = [];
	const ruff = resolveBin(fileDir, cwd, "ruff", "python");
	if (ruff) {
		tasks.push(
			runCheckCmd(
				pi,
				"ruff",
				ruff,
				["check", "--no-fix", "--output-format", "concise", absPath],
				cwd,
			),
		);
	}

	const hasPyrightConfig = Boolean(findNearestFile(fileDir, cwd, "pyrightconfig.json"));
	const pyright = hasPyrightConfig ? resolveBin(fileDir, cwd, "pyright", "python") : null;
	const ty = resolveBin(fileDir, cwd, "ty", "python");

	if (pyright) {
		tasks.push(runCheckCmd(pi, "pyright", pyright, [absPath], cwd));
	} else if (ty) {
		tasks.push(
			runCheckCmd(pi, "ty", ty, ["check", "--output-format", "concise", absPath], cwd),
		);
	}

	const results = await Promise.all(tasks);
	for (const r of results) {
		if (r) issues.push(r);
	}
	return issues;
}

async function checkJsTs(
	pi: ExtensionAPI,
	absPath: string,
	cwd: string,
	ext: string,
): Promise<CheckIssue[]> {
	const issues: CheckIssue[] = [];
	const fileDir = path.dirname(absPath);
	const isJsSyntaxCheckable = ext === ".js" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";

	if (isJsSyntaxCheckable) {
		const nodeErr = await runCheckCmd(pi, "node --check", "node", ["--check", absPath], cwd);
		if (nodeErr) {
			issues.push(nodeErr);
			return issues;
		}
	}

	const tasks: Promise<CheckIssue | null>[] = [];

	const biome = findProjectBin(fileDir, cwd, "biome", "node");
	if (biome) {
		tasks.push(runCheckCmd(pi, "biome", biome, ["check", absPath], cwd));
	} else {
		const eslint = findProjectBin(fileDir, cwd, "eslint", "node");
		if (eslint) {
			tasks.push(runCheckCmd(pi, "eslint", eslint, ["--format", "compact", absPath], cwd));
		}
	}

	if (isTs) {
		const tsconfig = findNearestFile(fileDir, cwd, "tsconfig.json");
		const tsc = tsconfig ? resolveBin(fileDir, cwd, "tsc", "node") : null;
		if (tsconfig && tsc) {
			tasks.push(
				runCheckCmd(
					pi,
					"tsc",
					tsc,
					["-p", tsconfig, "--noEmit", "--pretty", "false"],
					path.dirname(tsconfig),
				),
			);
		}
	}

	const results = await Promise.all(tasks);
	for (const r of results) {
		if (r) issues.push(r);
	}
	return issues;
}

async function checkShell(
	pi: ExtensionAPI,
	absPath: string,
	cwd: string,
): Promise<CheckIssue[]> {
	const issues: CheckIssue[] = [];
	const bashErr = await runCheckCmd(pi, "bash -n", "bash", ["-n", absPath], cwd);
	if (bashErr) {
		issues.push(bashErr);
		return issues;
	}
	const shellcheck = findGlobalBin("shellcheck");
	if (shellcheck) {
		const scErr = await runCheckCmd(
			pi,
			"shellcheck",
			shellcheck,
			["-f", "gcc", absPath],
			cwd,
		);
		if (scErr) issues.push(scErr);
	}
	return issues;
}

function checkJson(absPath: string): CheckIssue[] {
	try {
		const raw = fs.readFileSync(absPath, "utf8");
		JSON.parse(raw);
		return [];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return [{ tool: "json", output: msg }];
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	function getActiveToolsLabel(): string {
		const active: string[] = [];
		if (findGlobalBin("ruff")) active.push("ruff");
		if (findGlobalBin("ty")) active.push("ty");
		if (findGlobalBin("node")) active.push("node");
		return active.length > 0 ? active.join(",") : "basic";
	}

	function updateCheckStatus(ctx: ExtensionContext, warningText?: string) {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus("auto-check", ctx.ui.theme.fg("dim", "check:off"));
			return;
		}
		if (warningText) {
			ctx.ui.setStatus("auto-check", ctx.ui.theme.fg("warning", warningText));
			return;
		}
		ctx.ui.setStatus(
			"auto-check",
			ctx.ui.theme.fg("success", `check:on(${getActiveToolsLabel()})`),
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		updateCheckStatus(ctx);
	});

	pi.registerCommand("autocheck", {
		description: "Toggle or inspect lightweight post-edit auto-check (on|off|status)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			updateCheckStatus(ctx);
			ctx.ui.notify(
				`Auto-check: ${enabled ? "ON" : "OFF"} (tools: ${getActiveToolsLabel()})`,
				"info",
			);
		},
	});

	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		if (!enabled) return;
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const rawPath = event.input?.path;
		if (typeof rawPath !== "string" || !rawPath.trim()) return;

		const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath);
		if (shouldSkipPath(absPath) || !fs.existsSync(absPath)) return;

		const ext = path.extname(absPath).toLowerCase();
		let issues: CheckIssue[] = [];

		if (ext === ".py") {
			issues = await checkPython(pi, absPath, ctx.cwd);
		} else if (
			ext === ".ts" ||
			ext === ".tsx" ||
			ext === ".mts" ||
			ext === ".cts" ||
			ext === ".js" ||
			ext === ".jsx" ||
			ext === ".mjs" ||
			ext === ".cjs"
		) {
			issues = await checkJsTs(pi, absPath, ctx.cwd, ext);
		} else if (ext === ".sh" || ext === ".bash") {
			issues = await checkShell(pi, absPath, ctx.cwd);
		} else if (ext === ".json") {
			issues = checkJson(absPath);
		} else {
			// Skip .md, .txt, .log, images, etc.
			return;
		}

		const relPath = path.relative(ctx.cwd, absPath) || path.basename(absPath);

		if (issues.length === 0) {
			updateCheckStatus(ctx);
			return;
		}

		const tools = issues.map((i) => i.tool).join(",");
		updateCheckStatus(ctx, `check:⚠ ${path.basename(absPath)} (${tools})`);

		let report = issues
			.map((i) => `[${i.tool}]\n${i.output}`)
			.join("\n\n");
		if (report.length > MAX_CHARS_TOTAL) {
			report = `${report.slice(0, MAX_CHARS_TOTAL)}\n... (truncated)`;
		}

		const note = `\n[Auto-Check failed for ${relPath} — fix these before finalizing]:\n${report}`;
		return {
			content: [...event.content, { type: "text" as const, text: note }],
			...(event.structuredContent !== undefined
				? { structuredContent: event.structuredContent }
				: {}),
		};
	});
}

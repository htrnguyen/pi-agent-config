/**
 * Task-Aware Advisor, Guardrails & Review Extension
 *
 * Features:
 * 1. Smart Path & Command Guardrails (`tool_call` gate):
 *    - Protects real sensitive files (`.env`, `.env.local`, `.git/`, SSH/TLS private keys, `auth.json`, lockfiles)
 *      while allowing safe templates (`.env.example`, `.env.sample`, `.env.template`).
 *    - Intercepts destructive shell commands (`rm -rf`, `git reset --hard`, `git push --force`) for confirmation.
 * 2. Task-Aware Real-time Advisor (`/advisor` toggle):
 *    - Monitors turns where actual code/source files are modified (ignoring `.md`, `.txt`, memory notes).
 *    - Before the agent settles (`agent_before_settle`), injects a self-check turn ONLY if source code
 *      was modified without running a verification command afterward.
 * 3. `/review` Command:
 *    - Triggers a structured senior code review on current uncommitted git changes (or custom scope).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template", ".dist", ".schema"];
const PROTECTED_BASENAMES = new Set([
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"auth.json",
	"mcp-auth.json",
	"antigravity-accounts.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"Cargo.lock",
	"uv.lock",
]);
const PROTECTED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);
const DOC_OR_NOTE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".log", ".csv"]);

const DANGEROUS_BASH_REGEX =
	/\b(rm\s+-[a-zA-Z]*r[a-zA-Z]*f|git\s+reset\s+--hard|git\s+push\s+.*(--force|-f\b)|git\s+clean\s+-[a-zA-Z]*f|git\s+checkout\s+--\s+\.|git\s+restore\s+\.|mkfs|dd\s+if=)/i;

function isProtectedFile(rawPath: string): string | undefined {
	const normalized = rawPath.replace(/\\/g, "/").trim();
	if (!normalized) return undefined;

	if (normalized.includes("/.git/") || normalized.startsWith(".git/")) {
		return ".git/";
	}

	const base = basename(normalized);
	const lowerBase = base.toLowerCase();

	// Check .env* files, but allow .env.example / .env.sample / .env.template
	if (lowerBase === ".env" || lowerBase.startsWith(".env.")) {
		if (SAFE_ENV_SUFFIXES.some((sfx) => lowerBase.endsWith(sfx))) {
			return undefined;
		}
		return base;
	}

	if (PROTECTED_BASENAMES.has(base)) {
		return base;
	}

	const ext = extname(lowerBase);
	if (PROTECTED_EXTENSIONS.has(ext)) {
		return ext;
	}

	return undefined;
}

function isCodeFileRequiringVerification(rawPath: string): boolean {
	const normalized = rawPath.replace(/\\/g, "/").trim();
	if (!normalized) return false;
	if (normalized.includes("/project-memory/") || normalized.includes("/.pi/agent/")) {
		return false;
	}
	const ext = extname(normalized).toLowerCase();
	if (DOC_OR_NOTE_EXTENSIONS.has(ext)) {
		return false;
	}
	return true;
}

function readAdvisorPref(): boolean {
	try {
		const data = JSON.parse(readFileSync(join(getAgentDir(), "roles.json"), "utf8"));
		return data.advisorEnabled !== false;
	} catch {
		return true;
	}
}

function saveAdvisorPref(enabled: boolean): void {
	try {
		const p = join(getAgentDir(), "roles.json");
		const data = JSON.parse(readFileSync(p, "utf8"));
		data.advisorEnabled = enabled;
		writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
	} catch {
		// ignore
	}
}

export default function (pi: ExtensionAPI) {
	let advisorEnabled = readAdvisorPref();
	let modifiedCodeFiles = new Set<string>();
	let verifiedAfterEdit = false;
	let advisorTriggeredThisRun = false;

	function updateAdvisorStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"advisor",
			advisorEnabled ? ctx.ui.theme.fg("success", "advisor:on") : ctx.ui.theme.fg("dim", "advisor:off"),
		);
	}

	// 1. Guardrails: Protect sensitive paths & confirm dangerous bash commands
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = String(event.input.path ?? "");
			const hit = isProtectedFile(filePath);
			if (hit) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Protected path blocked by guardrail: ${filePath}` };
				}
				const ok = await ctx.ui.confirm(
					"Protected File Guard",
					`Cho phép sửa file nhạy cảm / lockfile "${filePath}" (khớp quy tắc "${hit}")?`,
				);
				if (!ok) {
					return { block: true, reason: `User rejected modification of protected path: ${filePath}` };
				}
			}
		}

		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command;
			if (DANGEROUS_BASH_REGEX.test(cmd)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Destructive command blocked in non-interactive mode: ${cmd}` };
				}
				const ok = await ctx.ui.confirm(
					"Destructive Command Guard",
					`Cho phép chạy lệnh có nguy cơ mất dữ liệu?\n\n$ ${cmd}`,
				);
				if (!ok) {
					return { block: true, reason: "Command blocked by user confirmation gate." };
				}
			}
		}

		return undefined;
	});

	// 2. Track source code edits vs verification commands during a run
	pi.on("agent_start", async () => {
		modifiedCodeFiles = new Set<string>();
		verifiedAfterEdit = false;
		advisorTriggeredThisRun = false;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = String(event.input.path ?? "");
			if (isCodeFileRequiringVerification(filePath)) {
				modifiedCodeFiles.add(filePath);
				verifiedAfterEdit = false;
			}
		}
		return undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.isError) return;
		if (event.toolName === "bash" && modifiedCodeFiles.size > 0) {
			verifiedAfterEdit = true;
		}
	});

	// 3. Task-Aware Advisor Hook: Only triggers when actual source code was modified without verification
	pi.on("agent_before_settle", async (event) => {
		advisorEnabled = readAdvisorPref();
		if (!advisorEnabled || modifiedCodeFiles.size === 0 || verifiedAfterEdit || advisorTriggeredThisRun) {
			return;
		}
		advisorTriggeredThisRun = true;
		const fileList = [...modifiedCodeFiles].slice(0, 5).join(", ");
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "advisor-check",
					content: `[Advisor Check]: Source files were modified (${fileList}) without running a verification command afterward. Run the relevant typecheck/linter/test (or inspect git diff if no test runner applies) to ensure zero regressions before finalizing.`,
					display: false,
				},
			],
			continue: true,
		};
	});

	// 4. `/advisor` command to toggle real-time advisor
	pi.registerCommand("advisor", {
		description: "Bật/tắt tự động kiểm tra code sau khi sửa file (on/off)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "on") advisorEnabled = true;
			else if (arg === "off") advisorEnabled = false;
			else advisorEnabled = !advisorEnabled;

			saveAdvisorPref(advisorEnabled);
			updateAdvisorStatus(ctx);
			ctx.ui.notify(`Real-time Advisor: ${advisorEnabled ? "ON" : "OFF"}`, "info");
		},
	});

	// 5. `/review` command to perform a comprehensive code review
	pi.registerCommand("review", {
		description: "Chạy Senior Code & Security Review trên git diff hiện tại (hoặc đường dẫn chỉ định)",
		handler: async (args, ctx) => {
			const scope = args?.trim() || "uncommitted git diff (`git status --short` and `git diff HEAD`)";
			const reviewPrompt = [
				`Perform a rigorous senior engineering code review on: ${scope}.`,
				"Steps:",
				"1. Inspect the modified files and diffs using `bash` (`git status --short`, `git diff`) and `read`.",
				"2. Check for logic bugs, edge cases, security vulnerabilities, race conditions, and type/contract mismatches.",
				"3. Output structured findings under:",
				"   - **Critical (Must Fix)**",
				"   - **Warnings (Should Fix)**",
				"   - **Suggestions**",
				"   - **Verdict**",
				"Do NOT modify any files during the review unless explicitly asked.",
			].join("\n");

			pi.sendUserMessage(reviewPrompt);
			if (ctx.hasUI) {
				ctx.ui.notify(`Đang chạy code review cho: ${scope}`, "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateAdvisorStatus(ctx);
	});
}

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
import type { UserMessage } from "@earendil-works/pi-ai";
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

const VERIFICATION_CMD_REGEX =
	/\b(pytest|vitest|jest|mocha|ava|tap|tsc(\s|$)|eslint|ruff|mypy|pyright|flake8|biome\s+check|cargo\s+(test|check|clippy)|go\s+test|make\s+test|python3?\s+-m\s+(py_compile|compileall|unittest|pytest)|node\s+--check|tsx\s+--no-emit|(npm|pnpm|yarn|bun)\s+(test|run\s+(test|typecheck|check|lint|build|verify)))\b/i;

const MUTATING_BASH_IN_RO_REGEX =
	/(\bsed\s+-i|\btee\s+|\brm\s+|\bmv\s+|\bcp\s+|\btouch\s+|\bmkdir\s+|\bchmod\s+|\bpatch\s+|\b(python3?|node|bun)\s+-(c|e)\b|\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall)\b|\bgit\s+(commit|reset|checkout|restore|apply|stash\s+pop|clean|merge|rebase|cherry-pick)|(?<![0-9&])>>?\s*(?!\/dev\/null\b))/i;

const SENSITIVE_CODE_PATH_REGEX =
	/(auth|security|crypto|token|secret|permission|rbac|payment|billing|migration|schema|database)/i;
const MAX_VERIFICATION_REMINDERS = 2;

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

interface AdvisorRoleConfig {
	model?: string;
	fallbacks?: string[];
}

function readAdvisorRoleModels(): string[] {
	try {
		const data = JSON.parse(readFileSync(join(getAgentDir(), "roles.json"), "utf8")) as {
			modelRoles?: { advisor?: AdvisorRoleConfig };
		};
		const adv = data.modelRoles?.advisor;
		if (!adv) return [];
		return [adv.model, ...(adv.fallbacks ?? [])].filter((s): s is string => typeof s === "string" && s.includes("/"));
	} catch {
		return [];
	}
}

function parseProviderModel(spec: string): { provider: string; id: string } | undefined {
	const base = spec.split(":")[0]?.trim();
	if (!base) return undefined;
	const idx = base.indexOf("/");
	if (idx <= 0 || idx >= base.length - 1) return undefined;
	return { provider: base.slice(0, idx), id: base.slice(idx + 1) };
}

const ADVISOR_REVIEW_SYSTEM_PROMPT = `You are an independent read-only Senior Code Advisor reviewing uncommitted git changes made by another coding agent.
Inspect the git diff carefully for genuine logic bugs, security vulnerabilities, race conditions, broken contracts, or missing edge-case guards.
Do NOT nitpick style, formatting, or invent speculative issues.
If the diff is sound, reply starting with:
APPROVE
followed by 1-2 concise bullet points summarizing what you verified.
If there are genuine issues that must be fixed, reply starting with:
REQUEST_CHANGES
followed by concise bullet points citing File + Line/Symbol + Issue + Fix.`;

async function runIndependentAdvisorReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	files: string[],
): Promise<{ modelKey: string; verdict: "APPROVE" | "REQUEST_CHANGES" | "ERROR"; feedback: string }> {
	const candidates = readAdvisorRoleModels();
	let targetModel: ReturnType<ExtensionContext["modelRegistry"]["find"]> | undefined;
	let modelKey = "";

	for (const spec of candidates) {
		const parsed = parseProviderModel(spec);
		if (!parsed) continue;
		const found = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (found) {
			targetModel = found;
			modelKey = `${parsed.provider}/${parsed.id}`;
			break;
		}
	}
	if (!targetModel) {
		return {
			modelKey: candidates.join(" / ") || "none",
			verdict: "ERROR",
			feedback: `Không tìm thấy model Advisor khả dụng trong registry (candidates: ${candidates.join(", ") || "trống"}).`,
		};
	}

	const diffRes = await pi.exec("git", ["diff", "HEAD", "--", ...files.slice(0, 12)], { cwd: ctx.cwd }).catch(() => ({
		stdout: "",
		code: 1,
	}));
	let reviewPayload = (diffRes.stdout ?? "").trim();

	// Fallback for repos without HEAD commit or newly created untracked files
	if (!reviewPayload) {
		const snippets: string[] = [];
		let remaining = 12_000;
		for (const relPath of files.slice(0, 8)) {
			if (remaining <= 200) break;
			try {
				const absPath = relPath.startsWith("/") ? relPath : join(ctx.cwd, relPath);
				const content = readFileSync(absPath, "utf-8").slice(0, Math.min(3_500, remaining));
				if (content.trim()) {
					snippets.push(`=== ${relPath} (untracked/new) ===\n${content}`);
					remaining -= content.length;
				}
			} catch {
				// ignore unreadable files
			}
		}
		reviewPayload = snippets.join("\n\n").trim();
	}
	if (!reviewPayload) {
		return {
			modelKey,
			verdict: "ERROR",
			feedback: `Không có git diff hoặc nội dung đọc được cho: ${files.join(", ")}.`,
		};
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 18_000);
	try {
		const userMsg: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Modified files (${files.length}): ${files.join(", ")}\n\nChanges:\n\`\`\`diff\n${reviewPayload.slice(0, 12_000)}\n\`\`\``,
				},
			],
			timestamp: Date.now(),
		};
		const resp = await ctx.modelRegistry.complete(
			targetModel,
			{ systemPrompt: ADVISOR_REVIEW_SYSTEM_PROMPT, messages: [userMsg] },
			{ signal: controller.signal, maxTokens: 700 },
		);
		const text = resp.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (!text) {
			return {
				modelKey,
				verdict: "ERROR",
				feedback: "Model Advisor trả về nội dung rỗng.",
			};
		}
		const isApprove = /^APPROVE\b/i.test(text);
		return {
			modelKey,
			verdict: isApprove ? "APPROVE" : "REQUEST_CHANGES",
			feedback: text,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			modelKey,
			verdict: "ERROR",
			feedback: `Lỗi gọi model Advisor: ${msg}`,
		};
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	let advisorEnabled = readAdvisorPref();
	let explicitReadOnlyRole = false;
	let modifiedCodeFiles = new Set<string>();
	let baselineDirtyFiles = new Set<string>();
	let verificationCmdIds = new Set<string>();
	let verificationAttempted = false;
	let verificationPassed = false;
	let verificationRemindersSent = 0;
	let advisorReviewTriggeredThisRun = false;

	pi.events.on("role:readonly-changed", (data: unknown) => {
		const payload = data as { readOnly?: boolean } | undefined;
		explicitReadOnlyRole = Boolean(payload?.readOnly);
	});

	async function snapshotGitDirtyFiles(cwd?: string): Promise<Set<string>> {
		try {
			const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], cwd ? { cwd } : undefined);
			if (code !== 0 || !stdout.trim()) return new Set();
			const files = new Set<string>();
			for (const line of stdout.split("\n")) {
				const raw = line.slice(3).trim();
				if (raw) {
					const target = raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
					files.add(target);
				}
			}
			return files;
		} catch {
			return new Set();
		}
	}

	function updateAdvisorStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"advisor",
			advisorEnabled ? ctx.ui.theme.fg("success", "advisor:on") : ctx.ui.theme.fg("dim", "advisor:off"),
		);
	}

	// 1. Guardrails: Protect sensitive paths, confirm dangerous bash, and enforce [RO] bash guard
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

		const activeTools = new Set(pi.getActiveTools());
		const isReadOnlyRole = explicitReadOnlyRole || (!activeTools.has("edit") && !activeTools.has("write"));

		if (isReadOnlyRole && (event.toolName === "write" || event.toolName === "edit" || event.toolName === "codemode")) {
			return {
				block: true,
				reason: `Tool "${event.toolName}" is blocked because the current role is Read-Only.`,
			};
		}

		if (isReadOnlyRole && event.toolName === "subagent") {
			const inputObj = (event.input ?? {}) as Record<string, unknown>;
			const requestedAgent = String(inputObj.agent ?? "").toLowerCase();
			if (requestedAgent === "worker" || requestedAgent.endsWith("-writer")) {
				return {
					block: true,
					reason: `Delegating to writer subagent "${requestedAgent}" is blocked in a Read-Only role.`,
				};
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

			// Read-only role guard: confirm file-mutating bash commands
			if (isReadOnlyRole && MUTATING_BASH_IN_RO_REGEX.test(cmd)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Mutating bash command blocked in read-only role: ${cmd}` };
				}
				const ok = await ctx.ui.confirm(
					"Read-Only Role Guard",
					`Đang ở role Read-Only nhưng lệnh bash có dấu hiệu ghi/sửa file:\n\n$ ${cmd}\n\nVẫn cho phép chạy?`,
				);
				if (!ok) {
					return { block: true, reason: "Mutating bash command blocked in read-only role." };
				}
			}

			if (VERIFICATION_CMD_REGEX.test(cmd)) {
				verificationCmdIds.add(event.toolCallId);
			}
		}

		return undefined;
	});

	// 2. Track source code edits vs real verification commands during a run
	pi.on("agent_start", async (_event, ctx) => {
		modifiedCodeFiles = new Set<string>();
		verificationCmdIds = new Set<string>();
		verificationAttempted = false;
		verificationPassed = false;
		verificationRemindersSent = 0;
		advisorReviewTriggeredThisRun = false;
		baselineDirtyFiles = await snapshotGitDirtyFiles(ctx.cwd);
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = String(event.input.path ?? "");
			if (isCodeFileRequiringVerification(filePath)) {
				modifiedCodeFiles.add(filePath);
				verificationAttempted = false;
				verificationPassed = false;
			}
		}
		return undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "bash" && verificationCmdIds.has(event.toolCallId)) {
			verificationCmdIds.delete(event.toolCallId);
			verificationAttempted = true;
			verificationPassed = !event.isError;
		}
	});

	// 3. Separate Verification Guard & Independent Advisor Check before settle
	pi.on("agent_before_settle", async (event, ctx) => {
		advisorEnabled = readAdvisorPref();
		if (!advisorEnabled) {
			return;
		}

		// Also catch code files modified via bash (sed/python/redirect) during this run
		const currentDirty = await snapshotGitDirtyFiles(ctx.cwd);
		for (const filePath of currentDirty) {
			if (!baselineDirtyFiles.has(filePath) && isCodeFileRequiringVerification(filePath)) {
				modifiedCodeFiles.add(filePath);
			}
		}

		if (modifiedCodeFiles.size === 0) {
			return;
		}

		const filesArray = [...modifiedCodeFiles];
		const fileList = filesArray.slice(0, 5).join(", ");

		// Stage A: Verification Guard (separated from Advisor flag; up to 2 reminders if test is skipped or fails)
		if (!verificationPassed && verificationRemindersSent < MAX_VERIFICATION_REMINDERS) {
			verificationRemindersSent += 1;
			const msg = verificationAttempted
				? `[Verification Guard (${verificationRemindersSent}/${MAX_VERIFICATION_REMINDERS})]: Modified source files (${fileList}) and the last verification command FAILED. Fix the root cause and re-run the appropriate test/typecheck/lint command until it passes before finalizing.`
				: `[Verification Guard (${verificationRemindersSent}/${MAX_VERIFICATION_REMINDERS})]: Source files were modified (${fileList}) without running a real verification command afterward (e.g. pytest, tsc --noEmit, npm test, ruff/eslint). Run the relevant check before finalizing.`;

			return {
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: "advisor-check",
						content: msg,
						display: true,
					},
				],
				continue: true,
			};
		}

		// Stage B: Independent Advisor Model Review (`roles.json -> modelRoles.advisor`) for code changes after verification passes
		if (
			verificationPassed &&
			!advisorReviewTriggeredThisRun &&
			modifiedCodeFiles.size >= 1
		) {
			advisorReviewTriggeredThisRun = true;
			if (ctx.hasUI) {
				ctx.ui.setStatus("advisor", ctx.ui.theme.fg("warning", "advisor:reviewing..."));
				ctx.ui.notify(`Advisor đang review độc lập (${filesArray.length} file: ${fileList})...`, "info");
			}
			const review = await runIndependentAdvisorReview(pi, ctx, filesArray);
			updateAdvisorStatus(ctx);

			if (review.verdict === "APPROVE") {
				pi.sendMessage(
					{
						customType: "advisor-review-report",
						content: `[Independent Advisor (${review.modelKey}) — APPROVE]\nFiles: ${filesArray.join(", ")}\n\n${review.feedback}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}
			if (review.verdict === "REQUEST_CHANGES") {
				return {
					entries: [
						...event.entries,
						{
							type: "custom_message",
							customType: "advisor-review-gate",
							content: `[Independent Advisor (${review.modelKey}) — REQUEST_CHANGES]\nFiles: ${filesArray.join(", ")}\n\n${review.feedback}\n\nAddress the genuine issues above and re-run verification before finalizing.`,
							display: true,
						},
					],
					continue: true,
				};
			}
			pi.sendMessage(
				{
					customType: "advisor-review-report",
					content: `[Independent Advisor (${review.modelKey}) — SKIPPED/ERROR]\nFiles: ${filesArray.join(", ")}\n${review.feedback}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			return;
		}
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
				"3. For every genuine finding (do NOT invent issues if the code is sound), report:",
				"   - **Severity** (`Critical` | `Warning` | `Suggestion`)",
				"   - **File:Line**",
				"   - **Issue & Impact**",
				"   - **Evidence / Reproduction**",
				"   - **Suggested Fix**",
				"4. End with **Verdict** (`APPROVE` or `REQUEST_CHANGES`).",
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

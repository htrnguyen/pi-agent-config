/**
 * Adaptive & Explicit Role + Effort Router for Pi
 *
 * Combines 100% deterministic role->model:effort control (`roles.json`) with
 * task-aware routing (`autoRoute`), dynamic read-only tool locking, and automatic
 * provider fallback on HTTP 429/503/529.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRoute,
	type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface RoleEntry {
	/** Primary selector in `provider/modelId:effort` format */
	model: string;
	/** Fallback selectors in `provider/modelId:effort` format */
	fallbacks?: string[];
	/** If true, disables edit/write tools while this role is active */
	readOnly?: boolean;
	description?: string;
}

interface RolesConfigFile {
	autoRoute?: boolean;
	advisorEnabled?: boolean;
	defaultRole?: string;
	cycleOrder?: string[];
	modelRoles: Record<string, RoleEntry>;
}

interface ParsedSelector {
	provider: string;
	id: string;
	effort: ThinkingLevel;
}

const VALID_EFFORTS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseSelector(spec: string, fallbackEffort: ThinkingLevel = "medium"): ParsedSelector | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;

	const colonIdx = trimmed.lastIndexOf(":");
	let base = trimmed;
	let effort: ThinkingLevel = fallbackEffort;

	if (colonIdx > 0) {
		const maybeEffort = trimmed.slice(colonIdx + 1).toLowerCase() as ThinkingLevel;
		if (VALID_EFFORTS.has(maybeEffort)) {
			base = trimmed.slice(0, colonIdx);
			effort = maybeEffort;
		}
	}

	const slashIdx = base.indexOf("/");
	if (slashIdx <= 0 || slashIdx >= base.length - 1) return undefined;

	return {
		provider: base.slice(0, slashIdx),
		id: base.slice(slashIdx + 1),
		effort,
	};
}

function getConfigPath(cwd?: string): string {
	if (cwd) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "roles.json");
		if (existsSync(projectPath)) return projectPath;
	}
	return join(getAgentDir(), "roles.json");
}

function loadRolesConfig(cwd?: string): RolesConfigFile {
	const globalPath = join(getAgentDir(), "roles.json");
	const base: RolesConfigFile = {
		autoRoute: false,
		advisorEnabled: true,
		defaultRole: "coding",
		cycleOrder: ["default", "coding", "plan", "slow", "smol", "advisor"],
		modelRoles: {},
	};

	const paths = [globalPath];
	if (cwd) paths.push(join(cwd, CONFIG_DIR_NAME, "roles.json"));

	for (const p of paths) {
		if (existsSync(p)) {
			try {
				const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<RolesConfigFile>;
				if (typeof raw.autoRoute === "boolean") base.autoRoute = raw.autoRoute;
				if (typeof raw.advisorEnabled === "boolean") base.advisorEnabled = raw.advisorEnabled;
				if (typeof raw.defaultRole === "string") base.defaultRole = raw.defaultRole;
				if (Array.isArray(raw.cycleOrder)) base.cycleOrder = raw.cycleOrder;
				if (raw.modelRoles) Object.assign(base.modelRoles, raw.modelRoles);
			} catch (err) {
				console.error(`[roles] Error reading ${p}: ${err}`);
			}
		}
	}
	return base;
}

function saveGlobalRolesConfig(cfg: RolesConfigFile): void {
	const globalPath = join(getAgentDir(), "roles.json");
	writeFileSync(globalPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
}

function resolvePhysicalFromRole(
	roleName: string,
	cfg: RolesConfigFile,
	ctx: ExtensionContext,
	excludeModelKeys?: Set<string>,
): { model: Model<Api>; effort: ThinkingLevel; selector: string } | undefined {
	const entry = cfg.modelRoles[roleName] ?? cfg.modelRoles[cfg.defaultRole ?? "coding"];
	if (!entry) return undefined;

	const chain = [entry.model, ...(entry.fallbacks ?? [])];
	for (const spec of chain) {
		const parsed = parseSelector(spec);
		if (!parsed) continue;
		const key = `${parsed.provider}/${parsed.id}`;
		if (excludeModelKeys?.has(key)) continue;

		const found = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (found) {
			return { model: found, effort: parsed.effort, selector: spec };
		}
	}
	return undefined;
}

/** Task classifier used when `autoRoute: true` in roles.json */
function inferRoleFromTask(promptText: string, hasImages: boolean, cfg: RolesConfigFile): string | undefined {
	const text = promptText.trim().toLowerCase();
	if (!text && !hasImages) return undefined;

	if (hasImages && cfg.modelRoles.vision) {
		return "vision";
	}
	if (/\b(review|audit|kiểm tra diff|check diff|security review|pull request review)\b/i.test(text) && cfg.modelRoles.advisor) {
		return "advisor";
	}
	if (
		/\b(plan|architecture|thiết kế|kiến trúc|lên kế hoạch|phân tích hệ thống|rfc|roadmap)\b/i.test(text) &&
		!/\b(implement|viết code|sửa luôn|triển khai ngay)\b/i.test(text) &&
		cfg.modelRoles.plan
	) {
		return "plan";
	}
	if (
		/\b(race condition|deadlock|segfault|memory leak|root cause|bug khó|tại sao lỗi|deep debug|panic|core dump)\b/i.test(
			text,
		) &&
		cfg.modelRoles.slow
	) {
		return "slow";
	}
	if (
		text.length < 90 &&
		/\b(commit message|tóm tắt| dịch |translate|what is|là gì|giải thích ngắn)\b/i.test(text) &&
		cfg.modelRoles.smol
	) {
		return "smol";
	}
	if (/\b(implement|refactor|fix|sửa|thêm tính năng|viết hàm|code|update|tối ưu)\b/i.test(text) && cfg.modelRoles.coding) {
		return "coding";
	}
	return undefined;
}

const ROUTER_TIMEOUT_MS = 2500;
const SHORT_FOLLOWUP_REGEX =
	/^(ok|oke|okay|yes|yep|yeah|no|nope|tiếp|tiếp tục|làm đi|triển khai|triển khai ngay|đúng rồi|chuẩn|sửa nốt|sửa đi|chạy lại|thử lại|vẫn lỗi|vẫn lỗi kìa|xem lại|làm tiếp|continue|go ahead|do it|proceed|lgtm)[.!?\s]*$/i;

const ROUTER_SYSTEM_PROMPT = `You are a semantic intent router for a software engineering AI agent.
Given the user's message and the currently active role, output ONLY ONE label from:
KEEP, default, coding, plan, slow, advisor

Rules:
- KEEP: Short follow-ups, confirmations, or continuations of the current task (e.g., "ok", "làm đi", "tiếp tục", "vẫn lỗi kìa", "sửa nốt").
- default: Questions, explanations, reading/exploring code, or general chat where NO code edit is requested.
- coding: Writing, editing, refactoring, fixing bugs, implementing features, or pasting errors to fix.
- plan: Explicitly asking for a multi-step architecture plan, design blueprint, or implementation roadmap BEFORE coding.
- slow: Deeply complex bugs or audits: race conditions, deadlocks, memory leaks, segfaults/crash dumps, or hard distributed/system debugging.
- advisor: Asking to review code, audit git diff, check security, or verify implementation quality without editing.

Output ONLY the single exact label.`;

async function classifyTaskSemantically(
	promptText: string,
	currentRole: string,
	cfg: RolesConfigFile,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const trimmed = promptText.trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= 45 && SHORT_FOLLOWUP_REGEX.test(trimmed)) {
		return "KEEP";
	}

	const classifierRole =
		(cfg.modelRoles.tiny && "tiny") || (cfg.modelRoles.smol && "smol") || (cfg.modelRoles.default && "default");
	if (!classifierRole) return undefined;

	const resolved = resolvePhysicalFromRole(classifierRole, cfg, ctx);
	if (!resolved) return undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);
	try {
		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Current role: ${currentRole}\nUser message:\n${trimmed.slice(0, 1200)}`,
				},
			],
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			resolved.model,
			{ systemPrompt: ROUTER_SYSTEM_PROMPT, messages: [userMessage] },
			{ signal: controller.signal, maxTokens: 12 },
		);
		const raw = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.trim();
		const token = raw.split(/[\s,.:;!?]+/)[0];
		if (!token) return undefined;
		if (token.toUpperCase() === "KEEP") return "KEEP";
		const normalized = token.toLowerCase();
		if (["default", "coding", "plan", "slow", "advisor"].includes(normalized) && cfg.modelRoles[normalized]) {
			return normalized;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	let cfg = loadRolesConfig();
	let currentRole: string = cfg.defaultRole ?? "coding";
	let temporarilyRemovedWriteTools: string[] = [];
	let manualRoleLock = false;
	let consecutiveToolFailures = 0;
	let failureEscalatedThisRun = false;

	function syncReadOnlyTools(readOnly: boolean) {
		const active = new Set(pi.getActiveTools());
		if (readOnly) {
			const toRemove = ["edit", "write"].filter((t) => active.has(t));
			if (toRemove.length > 0) {
				temporarilyRemovedWriteTools = [...new Set([...temporarilyRemovedWriteTools, ...toRemove])];
				pi.setActiveTools([...active].filter((t) => t !== "edit" && t !== "write"));
			}
		} else if (temporarilyRemovedWriteTools.length > 0) {
			const restored = [...new Set([...active, ...temporarilyRemovedWriteTools])];
			temporarilyRemovedWriteTools = [];
			pi.setActiveTools(restored);
		}
	}

	function updateFooter(ctx: ExtensionContext, resolvedSelector?: string) {
		if (!ctx.hasUI) return;
		const entry = cfg.modelRoles[currentRole];
		const liveModel = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: (resolvedSelector?.split(":")[0] ?? entry?.model?.split(":")[0] ?? "auto");
		const liveEffort = pi.getThinkingLevel() || (resolvedSelector?.split(":")[1] ?? "medium");
		const badge = entry?.readOnly ? `role:${currentRole} [RO]` : `role:${currentRole}`;
		ctx.ui.setStatus(
			"role-preset",
			ctx.ui.theme.fg("accent", `${badge}`) +
				ctx.ui.theme.fg("muted", ` | model:${liveModel} | effort:${liveEffort}`),
		);
	}

	async function applyRole(roleName: string, ctx: ExtensionContext, notify = true): Promise<boolean> {
		cfg = loadRolesConfig(ctx.cwd);
		const entry = cfg.modelRoles[roleName];
		if (!entry) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Role "${roleName}" not found. Available: ${Object.keys(cfg.modelRoles).join(", ")}`,
					"warning",
				);
			}
			return false;
		}

		const resolved = resolvePhysicalFromRole(roleName, cfg, ctx);
		if (!resolved) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Could not resolve any available model for role "${roleName}" (tried: ${[entry.model, ...(entry.fallbacks ?? [])].join(", ")})`,
					"error",
				);
			}
			return false;
		}

		const switched = await pi.setModel(resolved.model);
		if (!switched && ctx.hasUI) {
			ctx.ui.notify(`No credentials for ${resolved.model.provider}/${resolved.model.id}`, "warning");
		}
		pi.setThinkingLevel(resolved.effort);

		// Dynamically lock/unlock edit & write without overwriting user/MCP tool changes
		syncReadOnlyTools(Boolean(entry.readOnly));

		currentRole = roleName;
		cfg.defaultRole = roleName;
		saveGlobalRolesConfig(cfg);
		updateFooter(ctx, `${resolved.model.provider}/${resolved.model.id}:${resolved.effort}`);

		if (notify && ctx.hasUI) {
			const roNote = entry.readOnly ? " [READ-ONLY]" : "";
			ctx.ui.notify(
				`Role [${roleName}]${roNote} -> ${resolved.model.provider}/${resolved.model.id} (effort: ${resolved.effort})`,
				"info",
			);
		}
		return true;
	}

	// Listen for role switch requests from `/setup` (`00-control-panel.ts`)
	pi.events.on("role:apply", (data: unknown) => {
		const payload = data as { role?: string; ctx?: ExtensionContext };
		if (payload?.role && payload?.ctx) {
			void applyRole(payload.role, payload.ctx, true);
		}
	});

	// Task-aware semantic routing when `autoRoute: true` or when image input requires a vision-capable model
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.text.trim().startsWith("/")) {
			return { action: "continue" };
		}
		consecutiveToolFailures = 0;
		failureEscalatedThisRun = false;
		cfg = loadRolesConfig(ctx.cwd);
		const hasImages = Array.isArray(event.images) && event.images.length > 0;

		// If user attached an image but current model doesn't support image input, auto-switch to vision role
		if (hasImages && ctx.model && !ctx.model.input?.includes("image") && cfg.modelRoles.vision) {
			await applyRole("vision", ctx, true);
			return { action: "continue" };
		}

		if (cfg.autoRoute && !manualRoleLock) {
			let decision = await classifyTaskSemantically(event.text, currentRole, cfg, ctx);
			if (decision === "KEEP") {
				return { action: "continue" };
			}
			if (!decision) {
				decision = inferRoleFromTask(event.text, hasImages, cfg);
			}
			if (decision && decision !== currentRole) {
				await applyRole(decision, ctx, true);
			}
		}
		return { action: "continue" };
	});

	// Auto-escalate to `slow` if 3+ consecutive tool failures occur in one run
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			consecutiveToolFailures += 1;
			if (
				consecutiveToolFailures >= 3 &&
				!failureEscalatedThisRun &&
				!manualRoleLock &&
				currentRole !== "slow" &&
				cfg.modelRoles.slow
			) {
				failureEscalatedThisRun = true;
				if (ctx.hasUI) {
					ctx.ui.notify("3 lỗi tool liên tiếp — tự động nâng lên role [slow] để xử lý sâu hơn.", "warning");
				}
				await applyRole("slow", ctx, false);
			}
		} else {
			consecutiveToolFailures = 0;
		}
	});

	pi.on("agent_settled", async () => {
		consecutiveToolFailures = 0;
		failureEscalatedThisRun = false;
	});

	pi.on("session_start", async () => {
		manualRoleLock = false;
		consecutiveToolFailures = 0;
		failureEscalatedThisRun = false;
	});

	// Register selectable virtual models `role/<name>` for every role in roles.json
	for (const roleName of Object.keys(cfg.modelRoles)) {
		pi.registerVirtualModel<{ tried?: string[] }>({
			provider: "role",
			id: roleName,
			name: `Role: ${roleName} (${cfg.modelRoles[roleName].model})`,
			thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
			contextWindow: 272_000,
			maxTokens: 128_000,
			route(request: ModelRouteRequest<{ tried?: string[] }>, ctx: ExtensionContext): ModelRoute<{ tried?: string[] }> {
				cfg = loadRolesConfig(ctx.cwd);
				const tried = new Set<string>(request.state?.tried ?? []);

				if (request.reason === "retry" && request.failed) {
					tried.add(`${request.failed.model.provider}/${request.failed.model.id}`);
				}

				const resolved = resolvePhysicalFromRole(roleName, cfg, ctx, tried) ?? resolvePhysicalFromRole(roleName, cfg, ctx);
				if (!resolved) {
					throw new Error(`No available model for role/${roleName}`);
				}
				return {
					model: resolved.model,
					thinkingLevel: resolved.effort,
					state: { tried: [...tried] },
				};
			},
		});
	}

	// Automatic fallback on rate-limit/error even when using physical models directly
	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status === 429 || event.status === 503 || event.status === 529) {
			cfg = loadRolesConfig(ctx.cwd);
			const activeKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			const fallback = resolvePhysicalFromRole(currentRole, cfg, ctx, new Set([activeKey]));
			if (fallback && ctx.hasUI) {
				ctx.ui.notify(
					`[Fallback] HTTP ${event.status} on ${activeKey} -> switching role [${currentRole}] to ${fallback.model.provider}/${fallback.model.id}:${fallback.effort}`,
					"warning",
				);
				await pi.setModel(fallback.model);
				pi.setThinkingLevel(fallback.effort);
				updateFooter(ctx, `${fallback.model.provider}/${fallback.model.id}:${fallback.effort}`);
			}
		}
	});

	// `/role` command: switch role, configure role->model:effort interactively, or list roles
	pi.registerCommand("role", {
		description:
			"Switch or configure task roles (`/role`, `/role <name>`, `/role set <role> <provider/model:effort>`, `/role config`)",
		handler: async (args, ctx) => {
			cfg = loadRolesConfig(ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);

			// `/role set <role> <provider/model:effort>`
			if (parts[0] === "set" && parts.length >= 3) {
				const targetRole = parts[1];
				const newSpec = parts[2];
				const parsed = parseSelector(newSpec);
				if (!parsed) {
					ctx.ui.notify(
						`Invalid format "${newSpec}". Expected: provider/model:effort (e.g. openai-codex/gpt-6-luna:medium)`,
						"error",
					);
					return;
				}
				const existing = cfg.modelRoles[targetRole] ?? { model: newSpec, fallbacks: [] };
				existing.model = `${parsed.provider}/${parsed.id}:${parsed.effort}`;
				cfg.modelRoles[targetRole] = existing;
				saveGlobalRolesConfig(cfg);
				ctx.ui.notify(`Saved role [${targetRole}] = ${existing.model} to ~/.pi/agent/roles.json`, "info");
				await applyRole(targetRole, ctx, true);
				return;
			}

			const configureRoleInteractive = async () => {
				const roleNames = Object.keys(cfg.modelRoles);
				const chosenRole = await ctx.ui.select(
					"Select Role to Configure",
					roleNames.map((r) => `${r} -> ${cfg.modelRoles[r].model}`),
				);
				if (!chosenRole) return;
				const roleKey = chosenRole.split(/\s+/)[0];

				const available = ctx.modelRegistry
					.getAvailable()
					.filter((m) => m.provider !== "role" && m.provider !== "router");
				const byProvider = new Map<string, string[]>();
				for (const m of available) {
					const list = byProvider.get(m.provider) ?? [];
					list.push(m.id);
					byProvider.set(m.provider, list);
				}

				const provChoices = [...byProvider.entries()]
					.sort((a, b) => a[0].localeCompare(b[0]))
					.map(([prov, ids]) => `${prov} (${ids.length} models)`);
				const chosenProv = await ctx.ui.select(`Select Provider for role [${roleKey}]`, provChoices);
				if (!chosenProv) return;
				const provName = chosenProv.split(/\s+/)[0];

				const modelIds = (byProvider.get(provName) ?? []).sort();
				const chosenModelId = await ctx.ui.select(`Select Model from [${provName}] for role [${roleKey}]`, modelIds);
				if (!chosenModelId) return;
				const chosenModel = `${provName}/${chosenModelId}`;

				const chosenEffort = (await ctx.ui.select(`Select Effort (Thinking Level) for ${chosenModel}`, [
					"low",
					"medium",
					"high",
					"xhigh",
					"minimal",
					"off",
				])) as ThinkingLevel | undefined;
				if (!chosenEffort) return;

				const newSpec = `${chosenModel}:${chosenEffort}`;
				cfg.modelRoles[roleKey].model = newSpec;
				saveGlobalRolesConfig(cfg);
				ctx.ui.notify(`Updated role [${roleKey}] -> ${newSpec}`, "info");
				await applyRole(roleKey, ctx, true);
			};

			// `/role config` -> interactive wizard to pick a role, provider, model, and effort
			if (parts[0] === "config") {
				await configureRoleInteractive();
				return;
			}

			// `/role auto` -> toggle semantic auto-route and clear manual lock
			if (parts[0] === "auto") {
				cfg.autoRoute = !cfg.autoRoute;
				if (cfg.autoRoute) manualRoleLock = false;
				saveGlobalRolesConfig(cfg);
				ctx.ui.notify(`Auto-route set to ${cfg.autoRoute ? "ON (semantic)" : "OFF"}`, "info");
				return;
			}

			// `/role <name>` -> direct switch
			if (parts.length === 1) {
				manualRoleLock = true;
				await applyRole(parts[0], ctx, true);
				return;
			}

			// `/role` with no args -> interactive selector
			const items = Object.entries(cfg.modelRoles).map(([name, entry]) => {
				const marker = name === currentRole ? "* " : "  ";
				const ro = entry.readOnly ? " [read-only]" : "";
				return `${marker}${name} -> ${entry.model}${ro} — ${entry.description ?? ""}`;
			});
			items.push("[Auto] Unlock manual override & re-enable semantic Auto-Route");
			items.push("[Config] Configure a role's model & effort (/role config)");

			const choice = await ctx.ui.select(
				`Switch Active Task Role (Auto-Route: ${cfg.autoRoute ? "ON" : "OFF"} | Alt+R to cycle)`,
				items,
			);
			if (!choice) return;

			if (choice.startsWith("[Auto]")) {
				manualRoleLock = false;
				cfg.autoRoute = true;
				saveGlobalRolesConfig(cfg);
				ctx.ui.notify("Semantic Auto-Route enabled & manual lock cleared.", "info");
				return;
			}

			if (choice.startsWith("[Config]")) {
				await configureRoleInteractive();
				return;
			}

			const selectedRole = choice.replace(/^\*\s+/, "").trim().split(/\s+/)[0];
			manualRoleLock = true;
			await applyRole(selectedRole, ctx, true);
		},
	});

	// `/roles` and `/pipeline` command to inspect the full role table
	const showRolesTable = async (_args: string, ctx: ExtensionContext) => {
		cfg = loadRolesConfig(ctx.cwd);
		const lines = [
			`Active Role: [${currentRole}] | Auto-Route: ${cfg.autoRoute ? "ON" : "OFF"} | Current Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}` : "none"}`,
			`Config file: ${getConfigPath(ctx.cwd)}`,
			"",
			"Configured Roles (use `/role <name>` to switch, `/role config` to change):",
		];
		for (const [name, entry] of Object.entries(cfg.modelRoles)) {
			const activeMark = name === currentRole ? "* " : "  ";
			const fb = entry.fallbacks?.length ? ` (fallbacks: ${entry.fallbacks.join(" -> ")})` : "";
			lines.push(`${activeMark}${name.padEnd(8)} : ${entry.model}${fb}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	};

	pi.registerCommand("roles", {
		description: "Show all configured task roles, assigned models, efforts, and fallback chains",
		handler: showRolesTable,
	});

	pi.registerCommand("pipeline", {
		description: "Show current role, model, effort, and fallback configuration",
		handler: showRolesTable,
	});

	// Cycle through `cycleOrder` with `Alt+R`
	pi.registerShortcut(Key.alt("r"), {
		description: "Cycle through task roles (default -> coding -> plan -> slow -> smol -> advisor)",
		handler: async (ctx) => {
			cfg = loadRolesConfig(ctx.cwd);
			const order = cfg.cycleOrder && cfg.cycleOrder.length > 0 ? cfg.cycleOrder : Object.keys(cfg.modelRoles);
			const idx = order.indexOf(currentRole);
			const nextRole = order[(idx + 1) % order.length];
			await applyRole(nextRole, ctx, true);
		},
	});

	// Keep footer HUD synced when user changes model via /models or effort via Shift+Tab
	pi.on("model_select", async (_event, ctx) => {
		updateFooter(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateFooter(ctx);
	});

	// Apply defaultRole on startup so the user starts on their exact configured coding model+effort
	pi.on("session_start", async (event, ctx) => {
		cfg = loadRolesConfig(ctx.cwd);
		currentRole = cfg.defaultRole ?? "coding";
		if (event.reason === "startup") {
			await applyRole(currentRole, ctx, false);
		} else {
			updateFooter(ctx);
		}
	});
}

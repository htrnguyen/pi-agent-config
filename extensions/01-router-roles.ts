/**
 * Explicit Role + Effort Controller for Pi
 *
 * Provides 100% deterministic role->model:effort control (`roles.json`),
 * dynamic read-only tool locking, and automatic single-fallback on HTTP 429/503/529.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

interface AdvisoryRouterConfig {
	enabled: boolean;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	mode: "suggest-only";
	confidenceThreshold: number;
	thresholds?: {
		toPaid?: number;
		fromPaid?: number;
		toCoding?: number;
		default?: number;
	};
	maxSuggestionsPerTask: number;
	timeoutMs: number;
	onFailure: "keep-current-role";
	requireConfirmation: boolean;
	paidRoles: string[];
	neverAutoSwitch: boolean;
}

interface RolesConfigFile {
	advisorEnabled?: boolean;
	defaultRole?: string;
	advisoryRouter?: Partial<AdvisoryRouterConfig>;
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

const DEFAULT_ADVISORY_ROUTER: AdvisoryRouterConfig = {
	enabled: true,
	provider: "zai",
	model: "glm-5.3-flash",
	thinking: "low",
	mode: "suggest-only",
	confidenceThreshold: 0.85,
	thresholds: {
		toPaid: 0.9,
		fromPaid: 0.75,
		toCoding: 0.8,
		default: 0.85,
	},
	maxSuggestionsPerTask: 1,
	timeoutMs: 1500,
	onFailure: "keep-current-role",
	requireConfirmation: true,
	paidRoles: ["plan", "slow"],
	neverAutoSwitch: true,
};

function getEffectiveThreshold(
	currentRole: string,
	targetRole: string,
	adv: AdvisoryRouterConfig,
): number {
	const t = adv.thresholds ?? {};
	const fromPaid = adv.paidRoles.includes(currentRole);
	const toPaid = adv.paidRoles.includes(targetRole);
	if (toPaid) return t.toPaid ?? 0.9;
	if (fromPaid && (targetRole === "default" || targetRole === "coding")) return t.fromPaid ?? 0.75;
	if (currentRole === "default" && targetRole === "coding") return t.toCoding ?? 0.8;
	return t.default ?? adv.confidenceThreshold ?? 0.85;
}

function getAdvisoryConfig(cfg: RolesConfigFile): AdvisoryRouterConfig {
	return { ...DEFAULT_ADVISORY_ROUTER, ...(cfg.advisoryRouter ?? {}) };
}

function loadRolesConfig(cwd?: string): RolesConfigFile {
	const globalPath = join(getAgentDir(), "roles.json");
	const base: RolesConfigFile = {
		advisorEnabled: true,
		defaultRole: "default",
		advisoryRouter: { ...DEFAULT_ADVISORY_ROUTER },
		cycleOrder: ["default", "coding", "plan", "slow", "advisor"],
		modelRoles: {},
	};

	const paths = [globalPath];
	if (cwd) paths.push(join(cwd, CONFIG_DIR_NAME, "roles.json"));

	for (const p of paths) {
		if (existsSync(p)) {
			try {
				const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<RolesConfigFile>;
				if (typeof raw.advisorEnabled === "boolean") base.advisorEnabled = raw.advisorEnabled;
				if (typeof raw.defaultRole === "string") base.defaultRole = raw.defaultRole;
				if (raw.advisoryRouter) {
					base.advisoryRouter = { ...base.advisoryRouter, ...raw.advisoryRouter };
				}
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

interface AdvisoryClassification {
	role: string;
	confidence: number;
	reason: string;
}

const SHORT_FOLLOWUP_REGEX =
	/^(ok|oke|okay|yes|yep|yeah|no|nope|tiếp|tiếp tục|làm đi|triển khai|triển khai ngay|đúng rồi|chuẩn|sửa nốt|sửa đi|chạy lại|thử lại|vẫn lỗi|vẫn lỗi kìa|xem lại|làm tiếp|continue|go ahead|do it|proceed|lgtm|done|thanks|cảm ơn)[.!?\s]*$/i;

const WRITE_CAPABLE_TOOLS = ["edit", "write", "codemode"] as const;
const DECLINE_COOLDOWN_TURNS = 4;

const ADVISORY_SYSTEM_PROMPT = `You are a lightweight advisory role classifier for a software engineering AI agent.
Given the user's new request and the current active role, classify which role best fits the request and output ONLY valid JSON:
{"role":"default|coding|plan|slow|advisor","confidence":0.0-1.0,"reason":"<brief 1-sentence Vietnamese explanation>"}

Role definitions:
- default: Questions, explanations, reading code, general chat, or simple queries (even asking "explain architecture of function X" belongs in default, NOT plan).
- coding: Implementing features, writing/editing code, fixing normal bugs, refactoring, UI/CSS styling (even if prompt mentions "design/thiết kế UI" or "pricing plan").
- plan: Explicitly designing large multi-component system architecture, major redesigns, or implementation roadmaps BEFORE writing code.
- slow: Deeply complex bugs, race conditions, deadlocks, memory leaks, crash dumps, or high-risk complex refactors.
- advisor: Auditing, reviewing code/diffs, security checks, or independent quality verification without editing.

If the prompt is ambiguous or a continuation of current work, keep the current role or output lower confidence (< 0.75). Output ONLY the JSON object.`;

function appendAdvisoryLog(entry: Record<string, unknown>): void {
	try {
		const logPath = join(getAgentDir(), "advisory-router-log.jsonl");
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// ignore logging failures
	}
}

async function classifyWithAdvisoryRouter(
	promptText: string,
	currentRole: string,
	adv: AdvisoryRouterConfig,
	cfg: RolesConfigFile,
	ctx: ExtensionContext,
): Promise<AdvisoryClassification | undefined> {
	const model = ctx.modelRegistry.find(adv.provider, adv.model);
	if (!model) return undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), adv.timeoutMs);
	try {
		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Current role: ${currentRole}\nUser prompt:\n${promptText.trim().slice(0, 1000)}`,
				},
			],
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: ADVISORY_SYSTEM_PROMPT, messages: [userMessage] },
			{ signal: controller.signal, maxTokens: 120 },
		);
		const raw = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.trim();
		const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		const parsed = JSON.parse(cleaned) as Partial<AdvisoryClassification>;
		if (
			typeof parsed.role === "string" &&
			cfg.modelRoles[parsed.role] &&
			typeof parsed.confidence === "number" &&
			Number.isFinite(parsed.confidence)
		) {
			return {
				role: parsed.role,
				confidence: Math.max(0, Math.min(1, parsed.confidence)),
				reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
			};
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
	let currentRole: string = cfg.defaultRole ?? "default";
	let temporarilyRemovedWriteTools: string[] = [];
	const declinedSuggestions = new Map<string, number>();
	const decisionCache = new Map<string, AdvisoryClassification>();
	let suggestionsShownForRun = 0;

	function syncReadOnlyTools(readOnly: boolean) {
		const active = new Set(pi.getActiveTools());
		if (readOnly) {
			const toRemove = WRITE_CAPABLE_TOOLS.filter((t) => active.has(t));
			if (toRemove.length > 0) {
				temporarilyRemovedWriteTools = [...new Set([...temporarilyRemovedWriteTools, ...toRemove])];
				pi.setActiveTools([...active].filter((t) => !(WRITE_CAPABLE_TOOLS as readonly string[]).includes(t)));
			}
		} else if (temporarilyRemovedWriteTools.length > 0) {
			const restored = [...new Set([...active, ...temporarilyRemovedWriteTools])];
			temporarilyRemovedWriteTools = [];
			pi.setActiveTools(restored);
		}
		pi.events.emit("role:readonly-changed", { readOnly, role: currentRole });
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

		currentRole = roleName;
		// Dynamically lock/unlock edit, write & codemode without overwriting defaultRole on disk
		syncReadOnlyTools(Boolean(entry.readOnly));
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

	// 1. Vision auto-fallback + 2. Hybrid Advisory Router (Rule Gate -> GLM Flash -> Yes/No, never auto-switches)
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.text.trim().startsWith("/")) {
			return { action: "continue" };
		}
		cfg = loadRolesConfig(ctx.cwd);
		const hasImages = Array.isArray(event.images) && event.images.length > 0;
		if (hasImages && ctx.model && !ctx.model.input?.includes("image")) {
			if (cfg.modelRoles.default) {
				await applyRole("default", ctx, true);
			}
			return { action: "continue" };
		}

		const adv = getAdvisoryConfig(cfg);
		if (!adv.enabled || !ctx.hasUI) return { action: "continue" };

		const trimmed = event.text.trim();
		if (!trimmed) return { action: "continue" };

		// Tier 1: Minimal Gate (only skip pure short acknowledgements; let LLM Router classify all real tasks)
		if (trimmed.length <= 35 && SHORT_FOLLOWUP_REGEX.test(trimmed)) {
			return { action: "continue" };
		}
		const isCurrentlyPaid = adv.paidRoles.includes(currentRole);
		if (!isCurrentlyPaid && trimmed.length < 20) {
			return { action: "continue" };
		}
		if (suggestionsShownForRun >= adv.maxSuggestionsPerTask) {
			return { action: "continue" };
		}

		// Tier 2: Lightweight GLM Flash classification (with cache + timeout fallback)
		const cacheKey = `${currentRole}::${trimmed.slice(0, 300)}`;
		let result = decisionCache.get(cacheKey);
		let latencyMs = 0;
		if (!result) {
			const t0 = Date.now();
			result = await classifyWithAdvisoryRouter(trimmed, currentRole, adv, cfg, ctx);
			latencyMs = Date.now() - t0;
			if (!result) {
				appendAdvisoryLog({
					ts: new Date().toISOString(),
					outcome: "timeout_or_error",
					currentRole,
					latencyMs,
					promptPreview: trimmed.slice(0, 120),
				});
				return { action: "continue" };
			}
			if (decisionCache.size >= 40) {
				const oldest = decisionCache.keys().next().value;
				if (oldest) decisionCache.delete(oldest);
			}
			decisionCache.set(cacheKey, result);
		}

		if (result.role === currentRole) return { action: "continue" };

		const threshold = getEffectiveThreshold(currentRole, result.role, adv);
		if (result.confidence < threshold) {
			appendAdvisoryLog({
				ts: new Date().toISOString(),
				outcome: "below_threshold",
				currentRole,
				suggestedRole: result.role,
				confidence: result.confidence,
				threshold,
				latencyMs,
				promptPreview: trimmed.slice(0, 120),
			});
			return { action: "continue" };
		}

		const pairKey = `${currentRole}->${result.role}`;
		if ((declinedSuggestions.get(pairKey) ?? 0) > 0) return { action: "continue" };

		// Always ask Yes/No — never auto-switch
		const currentEntry = cfg.modelRoles[currentRole];
		const targetEntry = cfg.modelRoles[result.role];
		const targetPaid = adv.paidRoles.includes(result.role);
		const costTag = targetPaid
			? "Paid API (genz-codex)"
			: isCurrentlyPaid
				? "Tiết kiệm API (rời khỏi Paid role)"
				: "Codex Plus / Free";

		const title = [
			`Role suggestion (${Math.round(result.confidence * 100)}%)`,
			`Current: ${currentRole} (${currentEntry?.model ?? "unknown"})`,
			`Suggested: ${result.role} (${targetEntry?.model ?? "unknown"}) · ${costTag}`,
			result.reason ? `Lý do: ${result.reason}` : "",
		]
			.filter(Boolean)
			.join("\n");

		suggestionsShownForRun += 1;
		const choice = await ctx.ui.select(title, [
			`Yes — Chuyển sang [${result.role}]${targetPaid ? " (Paid API)" : ""}`,
			`No — Giữ nguyên [${currentRole}]`,
		]);

		const accepted = Boolean(choice?.startsWith("Yes"));
		appendAdvisoryLog({
			ts: new Date().toISOString(),
			outcome: "suggested",
			currentRole,
			suggestedRole: result.role,
			confidence: result.confidence,
			threshold,
			latencyMs,
			reason: result.reason,
			accepted,
			promptPreview: trimmed.slice(0, 120),
		});

		if (accepted) {
			await applyRole(result.role, ctx, true);
		} else {
			declinedSuggestions.set(pairKey, DECLINE_COOLDOWN_TURNS);
		}

		return { action: "continue" };
	});

	pi.on("agent_settled", async () => {
		suggestionsShownForRun = 0;
		for (const [key, remaining] of declinedSuggestions.entries()) {
			if (remaining <= 1) {
				declinedSuggestions.delete(key);
			} else {
				declinedSuggestions.set(key, remaining - 1);
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		const isRO = Boolean(cfg.modelRoles[currentRole]?.readOnly);
		syncReadOnlyTools(isRO);
		if (isRO) {
			const roConstraint =
				"\n\n[ROLE CONSTRAINT: READ-ONLY MODE]\n" +
				`You are currently operating in the read-only [${currentRole}] role. ` +
				"Do NOT modify files, run mutating shell commands, or delegate file-writing tasks. Focus strictly on analysis, architecture planning, or review.";
			if (!event.systemPrompt.includes("[ROLE CONSTRAINT: READ-ONLY MODE]")) {
				return { systemPrompt: event.systemPrompt + roConstraint };
			}
		}
		return undefined;
	});

	pi.on("session_tree", async () => {
		syncReadOnlyTools(Boolean(cfg.modelRoles[currentRole]?.readOnly));
	});

	pi.on("session_start", async () => {
		declinedSuggestions.clear();
		decisionCache.clear();
		suggestionsShownForRun = 0;
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

				const resolved = resolvePhysicalFromRole(roleName, cfg, ctx, tried);
				if (!resolved) {
					throw new Error(`No available fallback model remaining for role/${roleName} (tried: ${[...tried].join(", ")})`);
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

			// `/role advisory` -> toggle Hybrid Advisory Router (suggest-only)
			if (parts[0] === "advisory") {
				const adv = getAdvisoryConfig(cfg);
				adv.enabled = !adv.enabled;
				cfg.advisoryRouter = adv;
				saveGlobalRolesConfig(cfg);
				ctx.ui.notify(
					`Advisory Router (suggest-only): ${adv.enabled ? "ON (glm-5.3-flash)" : "OFF"}`,
					"info",
				);
				return;
			}

			// `/role <name>` -> direct switch
			if (parts.length === 1) {
				declinedSuggestions.clear();
				await applyRole(parts[0], ctx, true);
				return;
			}

			// `/role` with no args -> interactive selector
			const items = Object.entries(cfg.modelRoles).map(([name, entry]) => {
				const marker = name === currentRole ? "* " : "  ";
				const ro = entry.readOnly ? " [read-only]" : "";
				return `${marker}${name} -> ${entry.model}${ro} — ${entry.description ?? ""}`;
			});
			items.push("[Config] Configure a role's model & effort (/role config)");

			const choice = await ctx.ui.select("Switch Active Task Role (Alt+R to cycle)", items);
			if (!choice) return;

			if (choice.startsWith("[Config]")) {
				await configureRoleInteractive();
				return;
			}

			const selectedRole = choice.replace(/^\*\s+/, "").trim().split(/\s+/)[0];
			await applyRole(selectedRole, ctx, true);
		},
	});

	// `/roles` and `/pipeline` command to inspect the full role table
	const showRolesTable = async (_args: string, ctx: ExtensionContext) => {
		cfg = loadRolesConfig(ctx.cwd);
		const lines = [
			`Active Role: [${currentRole}] | Current Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}` : "none"}`,
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

	// Apply defaultRole on startup so the user starts on their exact configured free/sub model+effort
	pi.on("session_start", async (event, ctx) => {
		cfg = loadRolesConfig(ctx.cwd);
		const adv = getAdvisoryConfig(cfg);
		const configuredDefault = cfg.defaultRole ?? "default";
		// Never boot a fresh session into a Paid API role (plan/slow)
		currentRole = adv.paidRoles.includes(configuredDefault) ? "default" : configuredDefault;
		if (event.reason === "startup") {
			await applyRole(currentRole, ctx, false);
		} else {
			syncReadOnlyTools(Boolean(cfg.modelRoles[currentRole]?.readOnly));
			updateFooter(ctx);
		}
	});
}

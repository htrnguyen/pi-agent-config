import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface BgJob {
	id: string;
	label: string;
	command: string;
	cwd: string;
	pid: number;
	status: "running" | "done" | "failed" | "stopped" | "timeout";
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	timeoutSec: number;
	lines: string[];
	lastLine: string;
	proc?: ChildProcess;
	timer?: ReturnType<typeof setTimeout>;
}

const WIDGET_KEY = "bg-bash-jobs";
const MAX_LINES = 200;
const DEFAULT_TIMEOUT_SEC = 1800;
const DOTS = 12;

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m < 60) return `${m}m${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

function deriveLabel(command: string, label?: string): string {
	const raw = (label || command.split(/\s+/).slice(0, 3).join(" ")).trim();
	return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
}

function killJobGroup(job: BgJob): void {
	if (!job.pid) return;
	try {
		process.kill(-job.pid, "SIGTERM");
		setTimeout(() => {
			try {
				if (job.status === "running" || job.status === "stopped" || job.status === "timeout") {
					process.kill(-job.pid, "SIGKILL");
				}
			} catch {
				// already exited
			}
		}, 1500).unref();
	} catch {
		try {
			job.proc?.kill("SIGKILL");
		} catch {
			// already exited
		}
	}
}

export default function bgBashExtension(pi: ExtensionAPI) {
	const jobs = new Map<string, BgJob>();
	let nextId = 1;
	let tickPhase = 0;
	let uiTimer: ReturnType<typeof setInterval> | null = null;
	let activeCtx: ExtensionContext | null = null;
	let widgetRegistered = false;
	let widgetTui: { requestRender?: () => void } | null = null;

	function runningJobs(): BgJob[] {
		return Array.from(jobs.values()).filter((j) => j.status === "running");
	}

	function stopUiTimer(): void {
		if (uiTimer) {
			clearInterval(uiTimer);
			uiTimer = null;
		}
	}

	function refreshWidget(): void {
		const ctx = activeCtx;
		if (!ctx?.hasUI) return;
		const running = runningJobs();
		if (running.length === 0) {
			stopUiTimer();
			if (widgetRegistered) {
				widgetRegistered = false;
				widgetTui = null;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
			return;
		}

		if (!widgetRegistered) {
			widgetRegistered = true;
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				widgetTui = tui;
				return {
					render(width: number): string[] {
						const current = runningJobs();
						if (current.length === 0) return [];
						const out: string[] = [];
						const header =
							theme.fg("accent", "ⓘ ") +
							theme.fg("text", `waiting on ${current.length} job${current.length > 1 ? "s" : ""}`);
						out.push(truncateToWidth(header, width));

						for (const job of current.slice(0, 5)) {
							const elapsed = formatElapsed(Date.now() - job.startedAt);
							const preview = job.lastLine ? ` · ${job.lastLine}` : "";
							const left = `${theme.fg("dim", "└ ⋮ ")}${theme.fg("bashMode", "[bash]")} ${theme.fg("text", job.label)} ${theme.fg("muted", job.id)}${theme.fg("dim", preview)}`;
							const right = theme.fg("dim", elapsed);
							const rightW = visibleWidth(right);
							const leftTrimmed = truncateToWidth(left, Math.max(10, width - rightW - 2));
							const gap = Math.max(1, width - visibleWidth(leftTrimmed) - rightW);
							out.push(truncateToWidth(`${leftTrimmed}${" ".repeat(gap)}${right}`, width));

							const activePos = tickPhase % DOTS;
							let dots = "";
							for (let i = 0; i < DOTS; i++) {
								dots += i <= activePos ? theme.fg("success", "● ") : theme.fg("accent", "● ");
							}
							out.push(truncateToWidth(`  ${theme.fg("muted", job.id)} ${dots.trimEnd()}`, width));
						}

						if (current.length > 5) {
							out.push(truncateToWidth(theme.fg("dim", `  +${current.length - 5} more background job(s)`), width));
						}
						return out;
					},
					invalidate() {},
				};
			});
		} else {
			widgetTui?.requestRender?.();
		}

		if (!uiTimer) {
			uiTimer = setInterval(() => {
				tickPhase = (tickPhase + 1) % DOTS;
				widgetTui?.requestRender?.();
			}, 1000);
			uiTimer.unref();
		}
	}

	function pushOutput(job: BgJob, chunk: Buffer | string): void {
		const clean = stripAnsi(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		if (!clean) return;
		for (const rawLine of clean.split("\n")) {
			const line = rawLine.trimEnd();
			if (!line) continue;
			job.lines.push(line);
			if (job.lines.length > MAX_LINES) {
				job.lines.splice(0, job.lines.length - MAX_LINES);
			}
			job.lastLine = line.length > 60 ? `${line.slice(0, 59)}…` : line;
		}
	}

	function notifyJobFinished(job: BgJob): void {
		const elapsed = formatElapsed((job.endedAt ?? Date.now()) - job.startedAt);
		const tail = job.lines.slice(-15).join("\n");
		const summary = [
			`[bg_bash ${job.id}] ${job.status.toUpperCase()} (exit=${job.exitCode ?? "null"}, ${elapsed}): ${job.label}`,
			tail ? `\`\`\`\n${tail}\n\`\`\`` : "(no output)",
		].join("\n");

		try {
			pi.sendMessage(
				{
					customType: "bg-bash-done",
					content: summary,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// session may already be closing
		}
	}

	function startJob(command: string, cwd: string, label?: string, timeoutSec = DEFAULT_TIMEOUT_SEC): BgJob {
		const id = `bg_${nextId++}`;
		const proc = spawn("bash", ["-lc", command], {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		const job: BgJob = {
			id,
			label: deriveLabel(command, label),
			command,
			cwd,
			pid: proc.pid ?? 0,
			status: "running",
			startedAt: Date.now(),
			timeoutSec,
			lines: [],
			lastLine: "started",
			proc,
		};

		proc.stdout?.on("data", (d) => pushOutput(job, d));
		proc.stderr?.on("data", (d) => pushOutput(job, d));

		if (timeoutSec > 0) {
			job.timer = setTimeout(() => {
				if (job.status !== "running") return;
				job.status = "timeout";
				job.endedAt = Date.now();
				killJobGroup(job);
				refreshWidget();
				notifyJobFinished(job);
			}, timeoutSec * 1000);
			job.timer.unref();
		}

		proc.on("close", (code) => {
			if (job.timer) clearTimeout(job.timer);
			if (job.status === "running") {
				job.status = code === 0 ? "done" : "failed";
				job.endedAt = Date.now();
				job.exitCode = code;
				refreshWidget();
				notifyJobFinished(job);
			} else {
				job.exitCode = code;
				refreshWidget();
			}
		});

		proc.on("error", (err) => {
			if (job.timer) clearTimeout(job.timer);
			pushOutput(job, err.message);
			if (job.status === "running") {
				job.status = "failed";
				job.endedAt = Date.now();
				job.exitCode = -1;
				refreshWidget();
				notifyJobFinished(job);
			}
		});

		jobs.set(id, job);
		refreshWidget();
		return job;
	}

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		refreshWidget();
	});

	pi.on("session_shutdown", () => {
		stopUiTimer();
		for (const job of jobs.values()) {
			if (job.timer) clearTimeout(job.timer);
			if (job.status === "running") {
				job.status = "stopped";
				job.endedAt = Date.now();
				killJobGroup(job);
			}
		}
		activeCtx?.ui.setWidget(WIDGET_KEY, undefined);
		widgetRegistered = false;
		widgetTui = null;
		activeCtx = null;
	});

	pi.registerTool({
		name: "bg_bash",
		label: "Background Bash",
		description:
			"Run and manage long-running bash commands in the background with a live UI job widget. Actions: start (default), status, logs, stop, clear.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([
					Type.Literal("start"),
					Type.Literal("status"),
					Type.Literal("logs"),
					Type.Literal("stop"),
					Type.Literal("clear"),
				]),
			),
			command: Type.Optional(Type.String({ description: "Shell command to run (required for action='start')" })),
			label: Type.Optional(Type.String({ description: "Short display label for UI widget, e.g. 'deploy · containers'" })),
			id: Type.Optional(Type.String({ description: "Job ID like 'bg_1' (for status/logs/stop)" })),
			timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds (default 1800)" })),
			tailLines: Type.Optional(Type.Number({ description: "Number of log lines to return (default 40)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			activeCtx = ctx;
			const action = params.action ?? (params.command ? "start" : "status");

			if (action === "start") {
				if (!params.command?.trim()) {
					return {
						content: [{ type: "text", text: "Error: 'command' is required for action='start'." }],
						details: { ok: false },
					};
				}
				const timeoutSec = params.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
				const job = startJob(params.command, ctx.cwd, params.label, timeoutSec);
				return {
					content: [
						{
							type: "text",
							text: `Started background job ${job.id} (pid=${job.pid}, timeout=${timeoutSec}s): ${job.label}\nUse bg_bash({action:"logs", id:"${job.id}"}) or bg_bash({action:"stop", id:"${job.id}"}).`,
						},
					],
					details: { id: job.id, pid: job.pid, status: job.status, timeoutSec },
				};
			}

			if (action === "stop") {
				if (!params.id) {
					return { content: [{ type: "text", text: "Error: 'id' is required for action='stop'." }], details: {} };
				}
				const job = jobs.get(params.id);
				if (!job) {
					return { content: [{ type: "text", text: `Job '${params.id}' not found.` }], details: {} };
				}
				if (job.status === "running") {
					if (job.timer) clearTimeout(job.timer);
					job.status = "stopped";
					job.endedAt = Date.now();
					killJobGroup(job);
					refreshWidget();
				}
				return {
					content: [{ type: "text", text: `Stopped ${job.id} (${job.label}).` }],
					details: { id: job.id, status: job.status },
				};
			}

			if (action === "clear") {
				let removed = 0;
				for (const [id, job] of jobs.entries()) {
					if (job.status !== "running") {
						jobs.delete(id);
						removed++;
					}
				}
				refreshWidget();
				return {
					content: [{ type: "text", text: `Cleared ${removed} finished background job(s).` }],
					details: { removed },
				};
			}

			if (action === "logs" && params.id) {
				const job = jobs.get(params.id);
				if (!job) {
					return { content: [{ type: "text", text: `Job '${params.id}' not found.` }], details: {} };
				}
				const tail = Math.max(1, Math.min(MAX_LINES, params.tailLines ?? 40));
				const elapsed = formatElapsed((job.endedAt ?? Date.now()) - job.startedAt);
				const out = job.lines.slice(-tail).join("\n") || "(no output yet)";
				return {
					content: [{ type: "text", text: `[${job.id}] ${job.status} · ${job.label} · ${elapsed}\n${out}` }],
					details: { id: job.id, status: job.status, elapsed },
				};
			}

			const target = params.id ? [jobs.get(params.id)].filter((x): x is BgJob => Boolean(x)) : Array.from(jobs.values());
			if (target.length === 0) {
				return { content: [{ type: "text", text: "No background jobs." }], details: { count: 0 } };
			}
			const summary = target
				.map((j) => {
					const elapsed = formatElapsed((j.endedAt ?? Date.now()) - j.startedAt);
					return `${j.id} [${j.status}] ${j.label} (${elapsed})${j.lastLine ? ` — ${j.lastLine}` : ""}`;
				})
				.join("\n");
			return { content: [{ type: "text", text: summary }], details: { count: target.length } };
		},
	});

	pi.registerCommand("bg", {
		description: "Inspect or stop background bash jobs: /bg [list|logs <id>|stop <id|all>|clear]",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "list";

			if (sub === "clear") {
				let removed = 0;
				for (const [id, job] of jobs.entries()) {
					if (job.status !== "running") {
						jobs.delete(id);
						removed++;
					}
				}
				refreshWidget();
				ctx.ui.notify(`Cleared ${removed} finished job(s)`, "info");
				return;
			}

			if (sub === "stop") {
				const target = parts[1];
				if (!target) {
					ctx.ui.notify("Usage: /bg stop <id|all>", "warning");
					return;
				}
				const toStop =
					target === "all"
						? runningJobs()
						: [jobs.get(target)].filter((j): j is BgJob => Boolean(j && j.status === "running"));
				for (const job of toStop) {
					if (job.timer) clearTimeout(job.timer);
					job.status = "stopped";
					job.endedAt = Date.now();
					killJobGroup(job);
				}
				refreshWidget();
				ctx.ui.notify(`Stopped ${toStop.length} job(s)`, "info");
				return;
			}

			if (sub === "logs" && parts[1]) {
				const job = jobs.get(parts[1]);
				if (!job) {
					ctx.ui.notify(`Job '${parts[1]}' not found`, "warning");
					return;
				}
				const tail = job.lines.slice(-30).join("\n") || "(no output yet)";
				ctx.ui.notify(`[${job.id}] ${job.status}\n${tail}`, "info");
				return;
			}

			const all = Array.from(jobs.values());
			if (all.length === 0) {
				ctx.ui.notify("No background bash jobs", "info");
				return;
			}
			const lines = all.map((j) => {
				const elapsed = formatElapsed((j.endedAt ?? Date.now()) - j.startedAt);
				return `${j.id} [${j.status}] ${j.label} (${elapsed})`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

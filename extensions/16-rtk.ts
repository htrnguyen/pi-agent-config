/**
 * 16-rtk.ts — RTK (Rust Token Killer) command rewriter for Pi.
 *
 * Automatically rewrites noisy bash commands (`git status`, `pytest`, `rg`, `ruff`, etc.)
 * via `rtk rewrite` to compress verbose CLI output and save tokens.
 * Fail-open: if `rtk` is missing or errors, commands pass through unchanged.
 *
 * Command: `/rtk [on|off|status]`
 */

import type {
	BashToolCallEvent,
	ExtensionAPI,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 1_500;
const MIN_SUPPORTED_RTK_MINOR = 23;

function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
	return event.toolName === "bash";
}

function parseSemver(raw: string): [number, number, number] | null {
	const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

async function rewriteCommand(
	pi: ExtensionAPI,
	cmd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const result = await pi.exec("rtk", ["rewrite", cmd], {
		timeout: REWRITE_TIMEOUT_MS,
		signal,
	});
	if (result.killed) return null;
	if (result.code !== 0 && result.code !== 3) return null;
	return result.stdout.trim() || null;
}

export default async function (pi: ExtensionAPI) {
	let enabled = true;
	let available = false;
	let rtkVersion = "";

	const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS }).catch(() => ({
		code: 1,
		stdout: "",
	}));
	if (ver.code === 0) {
		const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""));
		if (!parsed || parsed[0] > 0 || parsed[1] >= MIN_SUPPORTED_RTK_MINOR) {
			available = true;
			rtkVersion = ver.stdout.trim();
		}
	}

	pi.registerCommand("rtk", {
		description: "Toggle or check RTK CLI token-saving rewriter (on|off|status)",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "on") enabled = true;
			else if (sub === "off") enabled = false;
			ctx.ui.notify(
				available
					? `RTK: ${enabled ? "ON" : "OFF"} (${rtkVersion})`
					: "RTK: unavailable (install rtk >= 0.23.0)",
				"info",
			);
		},
	});

	if (!available) return;

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		if (process.env.RTK_DISABLED === "1") return;
		try {
			if (!isBashToolCallEvent(event)) return;
			const cmd = event.input.command;
			if (typeof cmd !== "string" || cmd.trim() === "") return;
			if (cmd.startsWith("rtk ")) return;

			const rewritten = await rewriteCommand(pi, cmd, (ctx as { signal?: AbortSignal }).signal);
			if (rewritten && rewritten !== cmd) {
				event.input.command = rewritten;
			}
		} catch {
			// Fail open: never block execution
		}
	});
}

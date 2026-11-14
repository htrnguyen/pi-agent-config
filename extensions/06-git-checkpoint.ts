/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;

	// Track the current leaf entry ID (including user message entry at turn_start for /fork alignment)
	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;

		// Skip gracefully when cwd is not inside a git work tree
		const check = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd }).catch(() => ({
			code: 1,
			stdout: "",
		}));
		if (check.code !== 0) return;

		// Create a git stash entry before LLM makes changes
		const { stdout, code } = await pi.exec("git", ["stash", "create"], { cwd: ctx.cwd });
		const ref = code === 0 ? stdout.trim() : "";
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
			if (checkpoints.size > 30) {
				const oldestKey = checkpoints.keys().next().value;
				if (oldestKey) checkpoints.delete(oldestKey);
			}
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			const { code, stderr } = await pi.exec("git", ["stash", "apply", "--index", ref], { cwd: ctx.cwd });
			if (code !== 0) {
				const fallback = await pi.exec("git", ["stash", "apply", ref], { cwd: ctx.cwd });
				if (fallback.code !== 0) {
					ctx.ui.notify(`Checkpoint apply had conflicts: ${fallback.stderr || stderr}`, "warning");
					return;
				}
			}
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	pi.on("session_start", async () => {
		checkpoints.clear();
		currentEntryId = undefined;
	});

	pi.registerCommand("checkpoint", {
		description: "Create or restore a Git working-tree checkpoint (git stash create/apply)",
		handler: async (_args, ctx) => {
			const entries = Array.from(checkpoints.entries()).reverse();
			const options = [
				"Create manual checkpoint now",
				...entries.map(([id, ref], idx) => `Restore #${idx + 1}: ${ref.slice(0, 10)} (entry ${id.slice(0, 8)})`),
			];
			const choice = await ctx.ui.select("Git Checkpoints", options);
			if (!choice) return;

			if (choice.startsWith("Create manual")) {
				const { stdout, code } = await pi.exec("git", ["stash", "create"], { cwd: ctx.cwd });
				const ref = code === 0 ? stdout.trim() : "";
				if (!ref) {
					ctx.ui.notify("Working tree has no tracked modifications to checkpoint.", "info");
					return;
				}
				const leaf = ctx.sessionManager.getLeafEntry();
				const key = leaf?.id ?? currentEntryId ?? `manual-${Date.now()}`;
				checkpoints.set(key, ref);
				ctx.ui.notify(`Created checkpoint ${ref.slice(0, 10)}`, "info");
				return;
			}

			const match = entries.find(([, ref]) => choice.includes(ref.slice(0, 10)));
			if (match) {
				const { code, stderr } = await pi.exec("git", ["stash", "apply", match[1]], { cwd: ctx.cwd });
				if (code !== 0) {
					ctx.ui.notify(`Restore had conflicts: ${stderr.trim()}`, "warning");
					return;
				}
				ctx.ui.notify(`Restored working tree from checkpoint ${match[1].slice(0, 10)}`, "info");
			}
		},
	});
}

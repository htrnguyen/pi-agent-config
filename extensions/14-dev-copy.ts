/**
 * Developer Copy & Terminal Command Viewer Extension
 *
 * - `/copy` (or `Alt+C`): Pick & copy any code block, bash script, command, or last response to clipboard (`wl-copy` / OSC 52).
 * - `/cmdlog`: View bash commands executed in the current session, inspect output, copy, or prefill into the editor.
 */

import { spawn } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

interface CopyItem {
	label: string;
	content: string;
}

interface BashHistoryEntry {
	id: string;
	command: string;
	output: string;
	isError: boolean;
	timestamp: number;
}

async function copyToClipboard(text: string): Promise<"wl-copy" | "osc52"> {
	const tryCmd = (cmd: string, args: string[]) =>
		new Promise<boolean>((resolve) => {
			try {
				const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
				child.on("error", () => resolve(false));
				child.on("close", (code) => resolve(code === 0));
				child.stdin.write(text);
				child.stdin.end();
			} catch {
				resolve(false);
			}
		});

	if (await tryCmd("wl-copy", [])) return "wl-copy";
	if (await tryCmd("xclip", ["-selection", "clipboard"])) return "wl-copy";
	if (await tryCmd("xsel", ["--clipboard", "--input"])) return "wl-copy";

	// OSC 52 fallback (works over SSH / Ghostty / Kitty / WezTerm)
	const b64 = Buffer.from(text, "utf8").toString("base64");
	process.stdout.write(`\x1b]52;c;${b64}\x07`);
	return "osc52";
}

function extractTextFromAssistant(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function extractCodeBlocks(markdown: string): Array<{ lang: string; code: string }> {
	const blocks: Array<{ lang: string; code: string }> = [];
	const regex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(markdown)) !== null) {
		const lang = (match[1] || "text").trim();
		const code = match[2].replace(/\n$/, "");
		if (code.trim()) {
			blocks.push({ lang, code });
		}
	}
	return blocks;
}

export default function (pi: ExtensionAPI) {
	const bashHistory: BashHistoryEntry[] = [];
	const pendingBashById = new Map<string, string>();

	pi.on("tool_call", (event) => {
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string })?.command ?? "").trim();
			if (cmd) pendingBashById.set(event.toolCallId, cmd);
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash") {
			const cmd = pendingBashById.get(event.toolCallId);
			pendingBashById.delete(event.toolCallId);
			if (!cmd) return;
			const rawResult = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
			const outText =
				rawResult?.content
					?.filter((c) => c?.type === "text" && typeof c.text === "string")
					.map((c) => c.text!)
					.join("\n")
					.trim() ?? "";
			bashHistory.push({
				id: event.toolCallId,
				command: cmd,
				output: outText,
				isError: Boolean(event.isError),
				timestamp: Date.now(),
			});
			if (bashHistory.length > 40) bashHistory.shift();
		}
	});

	pi.on("session_start", () => {
		bashHistory.length = 0;
		pendingBashById.clear();
	});

	async function openCopyPicker(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const items: CopyItem[] = [];

		// 1. Collect code blocks & bash scripts from recent assistant messages (newest first)
		const assistantTexts: string[] = [];
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const txt = extractTextFromAssistant(entry.message as AssistantMessage);
					if (txt) assistantTexts.push(txt);
				}
			}
		} catch {
			// ignore
		}

		const recentAssistants = assistantTexts.slice(-5).reverse();
		for (let msgIdx = 0; msgIdx < recentAssistants.length; msgIdx++) {
			const blocks = extractCodeBlocks(recentAssistants[msgIdx]);
			for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
				const { lang, code } = blocks[bIdx];
				const lines = code.split("\n");
				const preview = lines[0].trim().slice(0, 52);
				const tag = msgIdx === 0 ? "Latest" : `Prev-${msgIdx}`;
				items.push({
					label: `[${tag} · ${lang} · ${lines.length}L] ${preview}`,
					content: code,
				});
			}
		}

		// 2. Collect recent bash commands run in this session
		for (const cmdEntry of [...bashHistory].reverse().slice(0, 12)) {
			const status = cmdEntry.isError ? "✗" : "✓";
			const preview = cmdEntry.command.replace(/\s+/g, " ").slice(0, 58);
			items.push({
				label: `[bash ${status}] $ ${preview}`,
				content: cmdEntry.command,
			});
		}

		// 3. Full last assistant response
		if (recentAssistants[0]) {
			items.push({
				label: `[Full Last Response · ${recentAssistants[0].split("\n").length}L] Toàn bộ câu trả lời cuối`,
				content: recentAssistants[0],
			});
		}

		if (items.length === 0) {
			ctx.ui.notify("Chưa có code block hoặc lệnh bash nào để copy.", "info");
			return;
		}

		const picked = await ctx.ui.select(
			"Quick Copy (Code / Bash Script / Command) — Chọn để copy vào Clipboard",
			items.map((i) => i.label),
		);
		if (!picked) return;

		const target = items.find((i) => i.label === picked);
		if (!target) return;

		const method = await copyToClipboard(target.content);
		const lineCount = target.content.split("\n").length;
		ctx.ui.notify(`Đã copy (${lineCount} dòng, ${target.content.length} ký tự) qua ${method}.`, "info");
	}

	async function openCmdLog(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (bashHistory.length === 0) {
			ctx.ui.notify("Phiên này chưa chạy lệnh bash nào.", "info");
			return;
		}

		const reversed = [...bashHistory].reverse();
		const labels = reversed.map((e, i) => {
			const icon = e.isError ? "✗" : "✓";
			const cmdOneLine = e.command.replace(/\s+/g, " ").slice(0, 65);
			const outLines = e.output ? e.output.split("\n").length : 0;
			return `#${reversed.length - i} [${icon}] $ ${cmdOneLine} (${outLines}L output)`;
		});

		const picked = await ctx.ui.select("Terminal Command Viewer — Chọn lệnh để xem / copy / chạy lại", labels);
		if (!picked) return;

		const idx = labels.indexOf(picked);
		const entry = reversed[idx];
		if (!entry) return;

		const outPreview = entry.output ? entry.output.split("\n").slice(0, 8).join("\n") : "(no output)";
		const action = await ctx.ui.select(
			`$ ${entry.command}\n--- Output preview ---\n${outPreview.slice(0, 400)}`,
			[
				"Copy command ($ ...)",
				"Copy full output",
				"Prefill command into input (!...)",
			],
		);
		if (!action) return;

		if (action.startsWith("Copy command")) {
			await copyToClipboard(entry.command);
			ctx.ui.notify("Đã copy lệnh vào clipboard.", "info");
		} else if (action.startsWith("Copy full output")) {
			await copyToClipboard(entry.output || "(empty)");
			ctx.ui.notify("Đã copy output vào clipboard.", "info");
		} else if (action.startsWith("Prefill")) {
			ctx.ui.setEditorText(`!${entry.command}`);
		}
	}

	pi.registerCommand("copy", {
		description: "Copy nhanh code block, script bash hoặc lệnh từ phản hồi gần nhất (Alt+C)",
		handler: async (_args, ctx) => {
			await openCopyPicker(ctx);
		},
	});

	pi.registerCommand("cmdlog", {
		description: "Xem lịch sử lệnh bash & output trong phiên, copy hoặc chạy lại",
		handler: async (_args, ctx) => {
			await openCmdLog(ctx);
		},
	});

	pi.registerShortcut(Key.alt("c"), {
		description: "Quick Copy code block / bash script / command (/copy)",
		handler: async (ctx) => {
			await openCopyPicker(ctx);
		},
	});

	pi.registerShortcut(Key.alt("x"), {
		description: "Clear all text in the input editor immediately",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.setEditorText("");
			ctx.ui.notify("Đã xóa sạch khung nhập liệu (bấm Ctrl+- để hoàn tác nếu cần).", "info");
		},
	});
}

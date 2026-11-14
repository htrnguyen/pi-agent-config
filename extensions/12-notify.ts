/**
 * Pi Notify Extension (Desktop + Terminal + Sound)
 *
 * Notifies when Pi finishes a task (`agent_settled`):
 * - Linux Desktop: `notify-send` with project name, elapsed time, and summary
 * - Sound: `pw-play` / `paplay` playing freedesktop `complete.oga`
 * - Terminal fallback: OSC 777 (Ghostty/WezTerm), OSC 99 (Kitty), Windows Toast (WSL)
 *
 * Command: `/notify [on|off|sound on|sound off|always|smart|test|status]`
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PI_ICON_PATH = path.join(os.homedir(), ".pi", "agent", "pi-icon.svg");

const SOUND_CANDIDATES = [
	"/usr/share/sounds/freedesktop/stereo/complete.oga",
	"/usr/share/sounds/freedesktop/stereo/message.oga",
];

function sanitizeOscField(value: string): string {
	return value.replace(/[\x00-\x1f\x7f;\\]/g, " ").trim();
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/'/g, "''");
}

function windowsToastScript(title: string, body: string): string {
	const safeTitle = escapePowerShellSingleQuoted(title);
	const safeBody = escapePowerShellSingleQuoted(body);
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${safeTitle}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${sanitizeOscField(title)};${sanitizeOscField(body)}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${sanitizeOscField(title)}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${sanitizeOscField(body)}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => {});
}

function playDoneSound(): void {
	const soundFile = SOUND_CANDIDATES.find((p) => fs.existsSync(p));
	if (!soundFile) return;
	execFile("pw-play", [soundFile], (err) => {
		if (err) {
			execFile("paplay", [soundFile], () => {});
		}
	});
}

function sendDesktopAndTerminalNotify(title: string, body: string, withSound: boolean): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
		return;
	}

	// Linux Desktop Notification (Hyprland/Omarchy/GNOME/KDE)
	const icon = fs.existsSync(PI_ICON_PATH) ? PI_ICON_PATH : "utilities-terminal";
	execFile(
		"notify-send",
		["-a", "Pi Agent", "-i", icon, title, body],
		(err) => {
			if (err) {
				if (process.env.KITTY_WINDOW_ID) {
					notifyOSC99(title, body);
				} else {
					notifyOSC777(title, body);
				}
			}
		},
	);

	if (withSound) {
		playDoneSound();
	}
}

function extractLastAssistantSummary(ctx: ExtensionContext): string {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const content = entry.message.content;
			let raw = "";
			if (typeof content === "string") {
				raw = content;
			} else if (Array.isArray(content)) {
				raw = content
					.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join(" ");
			}
			const firstLine = raw
				.replace(/[#*`>_]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			if (firstLine) {
				return firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
			}
		}
	} catch {
		// ignore
	}
	return "Ready for input";
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let soundEnabled = true;
	let minElapsedMs = 2000;
	let turnStartedAt = 0;

	pi.on("agent_start", async () => {
		turnStartedAt = Date.now();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const elapsedMs = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
		turnStartedAt = 0;

		if (!enabled) return;
		if (minElapsedMs > 0 && elapsedMs < minElapsedMs) return;

		const projectName = path.basename(ctx.cwd) || "Pi";
		const sec = Math.max(1, Math.round(elapsedMs / 1000));
		const title = elapsedMs > 0 ? `Pi · ${projectName} (${sec}s)` : `Pi · ${projectName}`;
		const summary = extractLastAssistantSummary(ctx);

		sendDesktopAndTerminalNotify(title, summary, soundEnabled);
	});

	pi.registerCommand("notify", {
		description: "Configure desktop notifications (on|off|sound on|sound off|always|smart|test|status)",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "on") enabled = true;
			else if (sub === "off") enabled = false;
			else if (sub === "sound on") soundEnabled = true;
			else if (sub === "sound off") soundEnabled = false;
			else if (sub === "always") minElapsedMs = 0;
			else if (sub === "smart") minElapsedMs = 2000;
			else if (sub === "test") {
				const projectName = path.basename(ctx.cwd) || "Pi";
				sendDesktopAndTerminalNotify(
					`Pi · ${projectName}`,
					"Test notification — Pi desktop notify is working!",
					soundEnabled,
				);
				ctx.ui.notify("Sent test desktop notification", "info");
				return;
			}

			const modeLabel = minElapsedMs === 0 ? "always" : `smart >=${minElapsedMs / 1000}s`;
			ctx.ui.notify(
				`Notify: ${enabled ? "ON" : "OFF"} · sound: ${soundEnabled ? "ON" : "OFF"} · mode: ${modeLabel}`,
				"info",
			);
		},
	});
}

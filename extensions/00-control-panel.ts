import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getSettingsListTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  Container,
  type EditorTheme,
  Key,
  type SettingItem,
  SettingsList,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const ROLES_PATH = path.join(AGENT_DIR, "roles.json");

function readJson(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: Record<string, any>): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");

  let leftText = left;
  let rightText = right;
  const fixedWidth = 2;
  const minimumGap = 3;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
  return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function formatContextAndCost(ctx: ExtensionContext): { text: string; percent: number } {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const percent = contextWindow && usage && usage.percent !== null ? Math.round(usage.percent) : 0;
  const ctxPart =
    contextWindow && usage && usage.percent !== null
      ? `ctx ${percent}%/${(contextWindow / 1000).toFixed(0)}k`
      : "ctx 0%";

  let cost = 0;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        cost += m.usage?.cost?.total ?? 0;
      }
    }
  } catch {
    // ignore
  }
  const costPart = cost > 0 ? ` · $${cost.toFixed(3)}` : "";
  return { text: `${ctxPart}${costPart}`, percent };
}

/** Curated top-level commands shown when the user types just `/` */
const PINNED_SLASH_ITEMS: AutocompleteItem[] = [
  {
    value: "menu",
    label: "menu",
    description: "[Hub] Mở bảng Menu phân nhóm toàn bộ chức năng (Role, Review, MCP, Git, Hệ thống)",
  },
  {
    value: "setup",
    label: "setup",
    description: "[Config] Bảng bật/tắt nhanh cấu hình (Role, Advisor, Thinking, HUD, Cache, UI)",
  },
  {
    value: "role",
    label: "role",
    description: "[Router] Đổi Role hiện tại hoặc gán Model+Effort (/role config)",
  },
  {
    value: "models",
    label: "models",
    description: "[Model] Chọn Model theo từng Provider kèm Giá & tok/s (Ctrl+L / Alt+L)",
  },
  {
    value: "speed",
    label: "speed",
    description: "[Metrics] Xem tốc độ tok/s thực tế, giá ($in/$out) & thông số từng Model",
  },
  {
    value: "providers",
    label: "providers",
    description: "[Auth] Xem danh sách Provider đã login, hạn OAuth & số lượng model",
  },
  {
    value: "review",
    label: "review",
    description: "[Review] Chạy Senior Code Review trên git diff hiện tại",
  },
  {
    value: "advisor",
    label: "advisor",
    description: "[Safety] Bật/tắt tự động kiểm tra code trước khi chốt",
  },
  {
    value: "mcp",
    label: "mcp",
    description: "[MCP] Quản lý kết nối MCP servers & tools",
  },
  {
    value: "tools",
    label: "tools",
    description: "[Tools] Bật/tắt các công cụ (tools) của Agent",
  },
  {
    value: "compact",
    label: "compact",
    description: "[Session] Nén gọn lịch sử hội thoại để tiết kiệm token",
  },
  {
    value: "restart",
    label: "restart",
    description: "[System] Nạp lại toàn bộ Extensions, Settings, Roles, Skills không mất phiên chat",
  },
  {
    value: "exit",
    label: "exit",
    description: "[System] Thoát Pi an toàn (/quit)",
  },
];

function categorizeCommand(name: string, desc?: string): string {
  const cleanDesc = desc ?? "";
  if (cleanDesc.startsWith("[")) return cleanDesc;
  if (["setup", "menu", "settings", "theme", "reload", "restart", "exit", "quit"].includes(name)) {
    return `[System] ${cleanDesc}`;
  }
  if (["role", "roles", "pipeline", "model", "models", "speed", "stats", "usage", "providers"].includes(name)) {
    return `[Role/Model] ${cleanDesc}`;
  }
  if (["review", "advisor", "qna"].includes(name) || name.startsWith("piolium") || name.includes("review")) {
    return `[Review] ${cleanDesc}`;
  }
  if (["mcp", "tools", "goal"].includes(name) || name.includes("subagent") || name.includes("lens")) {
    return `[Tools/MCP] ${cleanDesc}`;
  }
  if (["checkpoint", "handoff", "bookmark", "compact", "clear", "resume", "fork", "tree"].includes(name)) {
    return `[Git/Session] ${cleanDesc}`;
  }
  if (name.startsWith("skill:")) {
    return `[Skill] ${cleanDesc}`;
  }
  return `[Command] ${cleanDesc}`;
}

const STATS_PATH = path.join(AGENT_DIR, "model-stats.json");

interface ModelPerfEntry {
  avgTokPerSec: number;
  lastTokPerSec: number;
  totalOutputTokens: number;
  totalElapsedSec: number;
  calls: number;
}

function formatPriceTag(m: { cost?: { input?: number; output?: number; cacheRead?: number } }): string {
  const inp = m.cost?.input ?? 0;
  const out = m.cost?.output ?? 0;
  if (inp === 0 && out === 0) return "free/sub";
  const cache = m.cost?.cacheRead ? ` c:$${m.cost.cacheRead}` : "";
  return `$${inp}/$${out}${cache}`;
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  let gitBranch: string | undefined;
  let compactingNow = false;
  let turnStartTime = 0;
  let lastTurnTokPerSec = 0;
  let liveActiveRole: string | undefined;
  let liveReadOnly: boolean | undefined;

  pi.events.on("role:readonly-changed", (data: unknown) => {
    const payload = data as { role?: string; readOnly?: boolean } | undefined;
    if (payload?.role) liveActiveRole = payload.role;
    if (typeof payload?.readOnly === "boolean") liveReadOnly = payload.readOnly;
    activeTui?.requestRender();
  });

  function hasObservationalMemoryCompactor(settings: Record<string, any>): boolean {
    const pkgs = Array.isArray(settings.packages) ? settings.packages : [];
    return pkgs.some((p: unknown) => typeof p === "string" && p.includes("pi-observational-memory"));
  }

  let idleCompactTimer: ReturnType<typeof setTimeout> | undefined;
  const IDLE_COMPACT_DELAY_MS = 180_000;
  const IDLE_COMPACT_THRESHOLD_TOKENS = 90_000;

  function clearIdleCompactTimer() {
    if (idleCompactTimer) {
      clearTimeout(idleCompactTimer);
      idleCompactTimer = undefined;
    }
  }

  function scheduleIdleCompact(ctx: ExtensionContext) {
    clearIdleCompactTimer();
    const settings = readJson(SETTINGS_PATH);
    if (settings.compaction?.enabled === false || hasObservationalMemoryCompactor(settings)) return;
    idleCompactTimer = setTimeout(() => {
      idleCompactTimer = undefined;
      if (compactingNow) return;
      const usage = ctx.getContextUsage();
      const currentTokens = usage?.tokens ?? null;
      if (currentTokens === null) return;
      const modelWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000;
      const idleThreshold = Math.min(IDLE_COMPACT_THRESHOLD_TOKENS, Math.floor(modelWindow * 0.65));
      if (currentTokens < idleThreshold) return;

      compactingNow = true;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Idle compact: ${Math.round(currentTokens / 1000)}k >= ${Math.round(idleThreshold / 1000)}k — đang tự động nén nhẹ...`,
          "info",
        );
      }
      ctx.compact({
        onComplete: () => {
          compactingNow = false;
          activeTui?.requestRender();
        },
        onError: () => {
          compactingNow = false;
        },
      });
    }, IDLE_COMPACT_DELAY_MS);
  }

  pi.on("input", () => {
    clearIdleCompactTimer();
    return { action: "continue" };
  });

  pi.on("agent_start", () => {
    clearIdleCompactTimer();
    activeTui?.requestRender();
  });

  pi.on("agent_settled", (_event, ctx) => {
    activeTui?.requestRender();
    scheduleIdleCompact(ctx);
  });

  pi.on("turn_start", () => {
    turnStartTime = Date.now();
  });

  pi.on("turn_end", (event, ctx) => {
    // 1. Measure tok/s for the turn that just completed
    if (turnStartTime > 0 && ctx.model) {
      const elapsedSec = (Date.now() - turnStartTime) / 1000;
      const msg = (event as any)?.message as AssistantMessage | undefined;
      const outTokens = msg?.usage?.output ?? 0;
      if (elapsedSec > 0.15 && outTokens > 0) {
        const tps = Math.round(outTokens / elapsedSec);
        lastTurnTokPerSec = tps;
        const modelKey = `${ctx.model.provider}/${ctx.model.id}`;
        const stats = readJson(STATS_PATH) as Record<string, ModelPerfEntry>;
        const prev = stats[modelKey] ?? {
          avgTokPerSec: tps,
          lastTokPerSec: tps,
          totalOutputTokens: 0,
          totalElapsedSec: 0,
          calls: 0,
        };
        const totalOut = prev.totalOutputTokens + outTokens;
        const totalSec = prev.totalElapsedSec + elapsedSec;
        stats[modelKey] = {
          avgTokPerSec: Math.round(totalOut / totalSec),
          lastTokPerSec: tps,
          totalOutputTokens: totalOut,
          totalElapsedSec: Number(totalSec.toFixed(2)),
          calls: prev.calls + 1,
        };
        writeJson(STATS_PATH, stats);
      }
      turnStartTime = 0;
    }

    // 2. Check adaptive compaction threshold (only if pi-observational-memory is not already governing compaction)
    if (compactingNow) return;
    const settings = readJson(SETTINGS_PATH);
    if (settings.compaction?.enabled === false || hasObservationalMemoryCompactor(settings)) return;

    const configuredThreshold = Number(settings.compactThresholdTokens ?? 120_000);
    if (!configuredThreshold || configuredThreshold <= 0) return;

    const usage = ctx.getContextUsage();
    const currentTokens = usage?.tokens ?? null;
    if (currentTokens === null) return;

    // Adapt threshold to smaller-context models (cap at 75% of model contextWindow if < configuredThreshold)
    const modelWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000;
    const threshold = Math.min(configuredThreshold, Math.floor(modelWindow * 0.75));
    if (currentTokens < threshold) return;

    compactingNow = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Context đạt ${Math.round(currentTokens / 1000)}k >= ${Math.round(threshold / 1000)}k — đang tự động nén (auto-compact)...`,
        "info",
      );
    }
    ctx.compact({
      onComplete: () => {
        compactingNow = false;
        if (ctx.hasUI) {
          ctx.ui.notify("Auto-compact hoàn tất", "info");
        }
        activeTui?.requestRender();
      },
      onError: (err) => {
        compactingNow = false;
        if (ctx.hasUI) {
          ctx.ui.notify(`Auto-compact lỗi: ${err.message}`, "error");
        }
      },
    });
  });

  pi.on("session_shutdown", () => {
    clearIdleCompactTimer();
    activeTui = undefined;
  });

  function applyHudEditor(ctx: ExtensionContext, enabled: boolean) {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
      return;
    }

    // Replace default footer so model/effort/role/advisor/ctx don't render twice;
    // keep only external statuses (MCP, LSP, etc.) on a single compact line.
    ctx.ui.setFooter((_tui, _theme, footerData) => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        const statuses = footerData.getExtensionStatuses();
        const extras: string[] = [];
        for (const [key, val] of statuses.entries()) {
          if (key === "role-preset" || key === "advisor" || !val) continue;
          extras.push(val);
        }
        if (extras.length === 0) return [];
        return [truncateToWidth(extras.join(" · "), width)];
      },
    }));

    const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

    function readImageDimensions(filePath: string): { width?: number; height?: number; sizeKb: number } | null {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return null;
        const sizeKb = Math.max(1, Math.round(stat.size / 1024));
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(Math.min(stat.size, 65536));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const b = buf.subarray(0, bytesRead);

        // PNG
        if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
          return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), sizeKb };
        }
        // GIF
        if (b.length >= 10 && b.subarray(0, 3).toString("ascii") === "GIF") {
          return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), sizeKb };
        }
        // WEBP
        if (
          b.length >= 30 &&
          b.subarray(0, 4).toString("ascii") === "RIFF" &&
          b.subarray(8, 12).toString("ascii") === "WEBP"
        ) {
          const chunk = b.subarray(12, 16).toString("ascii");
          if (chunk === "VP8X" && b.length >= 30) {
            const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
            const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
            return { width: w, height: h, sizeKb };
          }
          if (chunk === "VP8 " && b.length >= 30) {
            return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, sizeKb };
          }
          if (chunk === "VP8L" && b.length >= 25) {
            const bits = b.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, sizeKb };
          }
        }
        // JPEG
        if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
          let i = 2;
          while (i + 9 < b.length) {
            if (b[i] !== 0xff) {
              i++;
              continue;
            }
            const marker = b[i + 1];
            if (marker >= 0xc0 && marker <= 0xc3) {
              return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), sizeKb };
            }
            if (i + 3 >= b.length) break;
            const segLen = b.readUInt16BE(i + 2);
            if (segLen < 2) break;
            i += 2 + segLen;
          }
        }
        return { sizeKb };
      } catch {
        return null;
      }
    }

    function extractImageFilePath(raw: string): string | null {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return null;
      let cleaned = trimmed;
      if (
        (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
        (cleaned.startsWith("\"") && cleaned.endsWith("\""))
      ) {
        cleaned = cleaned.slice(1, -1);
      }
      if (cleaned.startsWith("file://")) {
        try {
          cleaned = decodeURIComponent(new URL(cleaned).pathname);
        } catch {
          return null;
        }
      }
      if (!IMAGE_EXT_RE.test(cleaned)) return null;
      try {
        return fs.statSync(cleaned).isFile() ? cleaned : null;
      } catch {
        return null;
      }
    }

    class DetailedHudEditor extends CustomEditor {
      private imagePastes = new Map<number, { path: string; label: string }>();
      private imageCounter = 0;

      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: 1 });
        activeTui = tui;
      }

      setText(text: string): void {
        this.imagePastes.clear();
        this.imageCounter = 0;
        super.setText(text);
      }

      expandPasteMarkers(text: string): string {
        const baseProto = Object.getPrototypeOf(DetailedHudEditor.prototype);
        let result: string =
          typeof baseProto?.expandPasteMarkers === "function"
            ? baseProto.expandPasteMarkers.call(this, text)
            : text;
        for (const [id, info] of this.imagePastes) {
          const re = new RegExp(`\\[img #${id}\\]`, "g");
          result = result.replace(re, () => info.path);
        }
        return result;
      }

      private tryInsertImageTag(rawText: string): boolean {
        const imgPath = extractImageFilePath(rawText);
        if (!imgPath) return false;
        const meta = readImageDimensions(imgPath);
        const extLabel = path.extname(imgPath).replace(/^\./, "").toUpperCase() || "IMG";
        const sizeLabel = meta ? `${meta.sizeKb}KB` : "";
        const dimLabel = meta?.width && meta?.height ? `${meta.width}×${meta.height}` : "";
        const label = [dimLabel, sizeLabel, extLabel].filter(Boolean).join(" · ");
        this.imageCounter += 1;
        const id = this.imageCounter;
        this.imagePastes.set(id, { path: imgPath, label });

        const self = this as any;
        self.cancelAutocomplete?.();
        self.exitHistoryBrowsing?.();
        self.lastAction = null;
        self.pushUndoSnapshot?.();

        const cursor = this.getCursor();
        const currentLine = this.getLines()[cursor.line] ?? "";
        const before = cursor.col > 0 ? currentLine[cursor.col - 1] ?? "" : "";
        const after = currentLine[cursor.col] ?? "";
        const lead = before && !/\s/.test(before) ? " " : "";
        const trail = after && !/\s/.test(after) ? " " : "";
        self.insertTextAtCursorInternal(`${lead}[img #${id}]${trail}`);
        return true;
      }

      private shouldCollapsePaste(text: string): boolean {
        const normalized = text
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/\t/g, "    ");
        const lines = normalized.split("\n");
        return lines.length > 20 || normalized.length > 400;
      }

      insertTextAtCursor(text: string): void {
        if (text && this.tryInsertImageTag(text)) {
          return;
        }
        if (text && this.shouldCollapsePaste(text)) {
          this.handlePaste(text);
          return;
        }
        super.insertTextAtCursor(text);
      }

      handleInput(data: string): void {
        const self = this as any;
        const looksLikeRawPaste =
          !self.isInPaste &&
          !data.startsWith("\x1b") &&
          !data.includes("\x1b[200~") &&
          (data.length > 400 || (data.length > 1 && (data.includes("\n") || data.includes("\r"))));
        if (looksLikeRawPaste) {
          this.handlePaste(data);
          return;
        }
        super.handleInput(data);
      }

      handlePaste(pastedText: string): void {
        if (this.tryInsertImageTag(pastedText)) {
          return;
        }
        const normalized = pastedText
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/\t/g, "    ");
        const lines = normalized.split("\n");
        const shouldCollapse = lines.length > 20 || normalized.length > 400;
        if (!shouldCollapse) {
          if (lines.length <= 10) {
            super.handlePaste(pastedText);
            return;
          }
          const self = this as any;
          self.cancelAutocomplete?.();
          self.exitHistoryBrowsing?.();
          self.lastAction = null;
          self.pushUndoSnapshot?.();
          const clean = normalized
            .split("")
            .filter((ch: string) => ch === "\n" || ch.charCodeAt(0) >= 32)
            .join("");
          self.insertTextAtCursorInternal(clean);
          return;
        }

        const self = this as any;
        self.cancelAutocomplete?.();
        self.exitHistoryBrowsing?.();
        self.lastAction = null;
        self.pushUndoSnapshot?.();

        const clean = normalized
          .split("")
          .filter((ch: string) => ch === "\n" || ch.charCodeAt(0) >= 32)
          .join("");
        const cleanLines = clean.split("\n");
        self.pasteCounter = (self.pasteCounter ?? 0) + 1;
        const pasteId: number = self.pasteCounter;
        self.pastes?.set(pasteId, clean);

        const marker =
          cleanLines.length > 20
            ? `[paste #${pasteId} +${cleanLines.length} lines]`
            : `[paste #${pasteId} ${clean.length} chars]`;
        self.insertTextAtCursorInternal(marker);
      }

      render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length < 2) return lines;

        const thm = ctx.ui.theme;
        const roles = readJson(ROLES_PATH);
        const activeRole = liveActiveRole ?? String(roles.defaultRole ?? "default");
        const isReadOnly = liveReadOnly ?? Boolean(roles.modelRoles?.[activeRole]?.readOnly);
        const advisorOn = roles.advisorEnabled !== false;

        const fullModelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "auto";
        const shortModel = ctx.model ? ctx.model.id : "auto";
        const effort = pi.getThinkingLevel() || "medium";
        const effortColor =
          effort === "high" || effort === "xhigh"
            ? "warning"
            : effort === "medium"
              ? "accent"
              : "success";

        const roleLabel = isReadOnly ? `[${activeRole} · RO]` : `[${activeRole}]`;
        const rolePart = thm.fg(isReadOnly ? "warning" : "accent", roleLabel);
        const modelPart = thm.fg("text", shortModel);
        const effortPart = thm.fg(effortColor, effort);
        const advPart = advisorOn ? thm.fg("success", "adv:on") : thm.fg("dim", "adv:off");

        const topLeft = ` ${rolePart} ${modelPart} ${thm.fg("dim", "·")} ${effortPart} `;
        const topRight = ` ${advPart} `;

        const ctxInfo = formatContextAndCost(ctx);
        const ctxColor = ctxInfo.percent >= 80 ? "error" : ctxInfo.percent >= 60 ? "warning" : "muted";
        const stats = readJson(STATS_PATH) as Record<string, ModelPerfEntry>;
        const savedTps = stats[fullModelKey]?.avgTokPerSec;
        const tpsToShow = lastTurnTokPerSec || savedTps || 0;
        const tpsPart = tpsToShow > 0 ? ` · ${tpsToShow} tok/s` : "";
        const bottomLeft = thm.fg(ctxColor, ` ${ctxInfo.text}${tpsPart} `);
        const bottomRight = thm.fg(
          "muted",
          ` ${formatCwd(ctx.cwd)}${gitBranch ? ` (${gitBranch})` : ""} `,
        );

        const borderColor = (text: string) => this.borderColor(text);
        lines[0] = fitBorder(topLeft, topRight, width, borderColor);
        lines[lines.length - 1] = fitBorder(bottomLeft, bottomRight, width, borderColor);

        const previewRows = this.renderAttachmentBar(width, thm);
        if (previewRows.length > 0) {
          return [...previewRows, ...lines];
        }
        return lines;
      }

      private renderAttachmentBar(width: number, thm: ExtensionContext["ui"]["theme"]): string[] {
        if (width < 20) return [];
        const currentText = this.getText();
        const pastesMap: Map<number, string> | undefined = (this as any).pastes;

        const pills: string[] = [];
        const seenImg = new Set<number>();
        const seenPaste = new Set<number>();

        for (const match of currentText.matchAll(/\[(img|paste) #(\d+)(?: [^\]]+)?\]/g)) {
          const kind = match[1];
          const id = Number(match[2]);
          if (kind === "img" && !seenImg.has(id) && this.imagePastes.has(id)) {
            seenImg.add(id);
            const info = this.imagePastes.get(id)!;
            pills.push(
              thm.fg("accent", "[") +
                thm.fg("warning", ` ▣ img #${id}`) +
                thm.fg("dim", " · ") +
                thm.fg("text", info.label) +
                " " +
                thm.fg("accent", "]"),
            );
          } else if (kind === "paste" && !seenPaste.has(id) && pastesMap?.has(id)) {
            seenPaste.add(id);
            const raw = pastesMap.get(id) ?? "";
            const lineCount = raw.split("\n").length;
            const sizeKb =
              raw.length >= 1024 ? `${(raw.length / 1024).toFixed(1)}KB` : `${raw.length}c`;
            const firstLine = raw
              .split("\n")
              .map((l) => l.trim())
              .find((l) => l.length > 0) ?? "";
            const snippet = firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine;
            const previewPart = snippet ? `${thm.fg("dim", " · ")}${thm.fg("muted", `"${snippet}"`)}` : "";
            pills.push(
              thm.fg("accent", "[") +
                thm.fg("success", ` ≡ paste #${id}`) +
                thm.fg("dim", " · ") +
                thm.fg("text", `${lineCount}L · ${sizeKb}`) +
                previewPart +
                " " +
                thm.fg("accent", "]"),
            );
          }
        }

        if (pills.length === 0) return [];

        const rows: string[] = [];
        const prefix = " ";
        let current = prefix;
        let currentW = 1;

        for (const pill of pills) {
          const pillW = visibleWidth(pill);
          const sep = currentW > 1 ? " " : "";
          if (currentW > 1 && currentW + sep.length + pillW > width) {
            rows.push(truncateToWidth(current, width));
            current = `${prefix}${pill}`;
            currentW = 1 + pillW;
          } else {
            current += `${sep}${pill}`;
            currentW += sep.length + pillW;
          }
        }
        if (currentW > 1) {
          rows.push(truncateToWidth(current, width));
        }
        return rows;
      }
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new DetailedHudEditor(tui, theme, keybindings);
      // Seed prompt history from current session branch so Up-arrow works even after /restart or /resume
      try {
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === "message" && entry.message.role === "user") {
            const c = entry.message.content;
            const text =
              typeof c === "string"
                ? c
                : Array.isArray(c)
                  ? c
                      .filter((p): p is { type: "text"; text: string } => p.type === "text")
                      .map((p) => p.text)
                      .join("\n")
                  : "";
            if (text.trim()) editor.addToHistory(text);
          }
        }
      } catch {
        // ignore
      }
      return editor;
    });
  }

  async function openSetupPanel(ctx: ExtensionCommandContext) {
    const settings = readJson(SETTINGS_PATH);
    const roles = readJson(ROLES_PATH);
    const roleNames =
      Array.isArray(roles.cycleOrder) && roles.cycleOrder.length > 0
        ? roles.cycleOrder
        : Object.keys(roles.modelRoles ?? { default: {} });

    const items: SettingItem[] = [
      {
        id: "role.default",
        label: "[Role] Active / Default Role",
        description: "Role đang dùng & mặc định khi mở Pi (dùng /role config để gán model+effort cho từng role)",
        currentValue: String(roles.defaultRole ?? roleNames[0] ?? "default"),
        values: roleNames,
      },
      {
        id: "model.thinking",
        label: "[Model] Thinking Effort",
        description: "Mức suy luận (effort) áp dụng ngay lập tức (off / minimal / low / medium / high / xhigh)",
        currentValue: String(pi.getThinkingLevel() || settings.defaultThinkingLevel || "medium"),
        values: ["off", "minimal", "low", "medium", "high", "xhigh"],
      },
      {
        id: "model.cacheWarming",
        label: "[Model] Prompt Cache Warming",
        description: "idle = giữ ấm cache 30 phút giúp phản hồi nhanh & rẻ hơn; streaming = chỉ khi đang chạy; off = tắt",
        currentValue: String(settings.cacheWarming ?? "idle"),
        values: ["idle", "streaming", "off"],
      },
      {
        id: "safety.advisor",
        label: "[Safety] Real-time Advisor",
        description: "Tự động nhắc kiểm tra syntax/test trước khi hoàn tất nếu agent vừa sửa file",
        currentValue: roles.advisorEnabled === false ? "off" : "on",
        values: ["on", "off"],
      },
      {
        id: "ui.detailedHud",
        label: "[UI] Detailed Border HUD",
        description: "Hiển thị trực tiếp Role, Model, Effort, Advisor, Context %, Cost & Git Branch trên viền ô nhập",
        currentValue: settings.detailedHud === false ? "off" : "on",
        values: ["on", "off"],
      },
      {
        id: "ui.hideThinking",
        label: "[UI] Hide Thinking Block",
        description: "on = ẩn khối suy nghĩ dài dòng của model trong khung chat cho gọn",
        currentValue: settings.hideThinkingBlock ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "ui.quietStartup",
        label: "[UI] Quiet Startup",
        description: "header = giữ Logo & phím tắt khởi động (ẩn danh sách dài); false = hiện toàn bộ; true = ẩn hết",
        currentValue: String(settings.quietStartup ?? "header"),
        values: ["header", "false", "true"],
      },
      {
        id: "ui.doubleEsc",
        label: "[UI] Double Esc Action",
        description: "Hành động khi nhấn Esc 2 lần lúc ô nhập trống (tree = mở cây hội thoại, fork = tách nhánh, none = tắt)",
        currentValue: String(settings.doubleEscapeAction ?? "tree"),
        values: ["tree", "fork", "none"],
      },
      {
        id: "session.autoCompact",
        label: "[Session] Auto Compact",
        description: "on = tự động nén ngữ cảnh khi sắp đầy (reserveTokens: 24k, keepRecentTokens: 32k)",
        currentValue: settings.compaction?.enabled === false ? "off" : "on",
        values: ["on", "off"],
      },
      {
        id: "session.compactThreshold",
        label: "[Session] Compact At Tokens",
        description: "Ngưỡng cứng tự động compact để context không bao giờ phình quá mức (100k / 120k / 150k / off)",
        currentValue: settings.compactThresholdTokens
          ? `${Math.round(Number(settings.compactThresholdTokens) / 1000)}k`
          : "120k",
        values: ["100k", "120k", "150k", "off"],
      },
      {
        id: "ui.skillCommands",
        label: "[UI] Show Skills in / Menu",
        description: "off = ẩn hơn 200 /skill:... khỏi menu / cho đỡ rối (vẫn gõ tay /skill:tên được)",
        currentValue: settings.enableSkillCommands ? "on" : "off",
        values: ["off", "on"],
      },
    ];

    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", "Pi Control Panel (/setup) — Up/Down chọn | Enter/Space đổi giá trị | Esc đóng"), 1, 0),
      );

      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 14),
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === "role.default") {
            const r = readJson(ROLES_PATH);
            r.defaultRole = newValue;
            writeJson(ROLES_PATH, r);
            pi.events.emit("role:apply", { role: newValue, ctx });
          } else if (id === "model.thinking") {
            const s = readJson(SETTINGS_PATH);
            s.defaultThinkingLevel = newValue;
            writeJson(SETTINGS_PATH, s);
            pi.setThinkingLevel(newValue as any);
          } else if (id === "model.cacheWarming") {
            const s = readJson(SETTINGS_PATH);
            s.cacheWarming = newValue;
            writeJson(SETTINGS_PATH, s);
          } else if (id === "safety.advisor") {
            const r = readJson(ROLES_PATH);
            r.advisorEnabled = newValue === "on";
            writeJson(ROLES_PATH, r);
            ctx.ui.setStatus(
              "advisor",
              newValue === "on" ? ctx.ui.theme.fg("success", "advisor:on") : ctx.ui.theme.fg("dim", "advisor:off"),
            );
          } else if (id === "ui.detailedHud") {
            const s = readJson(SETTINGS_PATH);
            s.detailedHud = newValue === "on";
            writeJson(SETTINGS_PATH, s);
            applyHudEditor(ctx, newValue === "on");
          } else if (id === "ui.hideThinking") {
            const s = readJson(SETTINGS_PATH);
            s.hideThinkingBlock = newValue === "on";
            writeJson(SETTINGS_PATH, s);
          } else if (id === "ui.quietStartup") {
            const s = readJson(SETTINGS_PATH);
            s.quietStartup = newValue === "true" ? true : newValue === "false" ? false : "header";
            writeJson(SETTINGS_PATH, s);
          } else if (id === "ui.doubleEsc") {
            const s = readJson(SETTINGS_PATH);
            s.doubleEscapeAction = newValue;
            writeJson(SETTINGS_PATH, s);
          } else if (id === "session.autoCompact") {
            const s = readJson(SETTINGS_PATH);
            s.compaction = { ...(s.compaction ?? {}), enabled: newValue === "on" };
            writeJson(SETTINGS_PATH, s);
          } else if (id === "session.compactThreshold") {
            const s = readJson(SETTINGS_PATH);
            s.compactThresholdTokens = newValue === "off" ? 0 : Number.parseInt(newValue, 10) * 1000;
            writeJson(SETTINGS_PATH, s);
          } else if (id === "ui.skillCommands") {
            const s = readJson(SETTINGS_PATH);
            s.enableSkillCommands = newValue === "on";
            writeJson(SETTINGS_PATH, s);
          }
          activeTui?.requestRender();
        },
        () => done(undefined),
      );

      container.addChild(list);
      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });

    ctx.ui.notify("Đã áp dụng & lưu cấu hình (settings.json / roles.json)", "info");
  }

  async function openModelPicker(ctx: ExtensionCommandContext) {
    const all = ctx.modelRegistry
      .getAvailable()
      .filter((m) => m.provider !== "role" && m.provider !== "router");

    if (all.length === 0) {
      ctx.ui.notify("Không tìm thấy model khả dụng nào.", "warning");
      return;
    }

    const byProvider = new Map<string, typeof all>();
    for (const m of all) {
      const arr = byProvider.get(m.provider) ?? [];
      arr.push(m);
      byProvider.set(m.provider, arr);
    }

    const currentProv = ctx.model?.provider;
    const providerEntries = [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const providerChoices = providerEntries.map(([prov, list]) => {
      const mark = prov === currentProv ? "* " : "  ";
      return `${mark}${prov} (${list.length} models)`;
    });

    const pickedProv = await ctx.ui.select("Chọn Provider (nhóm model)", providerChoices);
    if (!pickedProv) return;

    const providerName = pickedProv.replace(/^\*\s+/, "").trim().split(/\s+/)[0];
    const models = (byProvider.get(providerName) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    const currentId = ctx.model?.id;

    const stats = readJson(STATS_PATH) as Record<string, ModelPerfEntry>;
    const modelChoices = models.map((m) => {
      const mark = m.provider === currentProv && m.id === currentId ? "* " : "  ";
      const ctxStr = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "?";
      const priceStr = formatPriceTag(m);
      const perf = stats[`${m.provider}/${m.id}`];
      const tpsStr = perf?.avgTokPerSec ? ` | ~${perf.avgTokPerSec} tok/s` : "";
      return `${mark}${m.id} [${ctxStr} | ${priceStr}${tpsStr}]`;
    });

    const pickedModel = await ctx.ui.select(`Provider: ${providerName} — Chọn Model`, modelChoices);
    if (!pickedModel) return;

    const modelId = pickedModel.replace(/^\*\s+/, "").trim().split(/\s+/)[0];
    const target = models.find((m) => m.id === modelId);
    if (!target) return;

    const ok = await pi.setModel(target);
    if (ok) {
      ctx.ui.notify(`Đã chuyển sang ${target.provider}/${target.id}`, "info");
      activeTui?.requestRender();
    } else {
      ctx.ui.notify(`Chưa có credential cho ${target.provider}/${target.id}`, "warning");
    }
  }

  async function openProvidersView(ctx: ExtensionCommandContext) {
    const auth = readJson(path.join(AGENT_DIR, "auth.json"));
    const customModels = readJson(path.join(AGENT_DIR, "models.json"));
    const agyAccounts = readJson(path.join(AGENT_DIR, "antigravity-accounts.json"));
    const available = ctx.modelRegistry
      .getAvailable()
      .filter((m) => m.provider !== "role" && m.provider !== "router");

    const modelCounts = new Map<string, number>();
    for (const m of available) {
      modelCounts.set(m.provider, (modelCounts.get(m.provider) ?? 0) + 1);
    }

    const allProviders = new Set<string>([
      ...Object.keys(auth),
      ...Object.keys(customModels.providers ?? {}),
      ...modelCounts.keys(),
    ]);
    if (Array.isArray(agyAccounts.accounts) && agyAccounts.accounts.length > 0) {
      allProviders.add("antigravity");
    }

    const rows: string[] = [];
    for (const prov of [...allProviders].sort()) {
      const count = modelCounts.get(prov) ?? 0;
      const authEntry = auth[prov];
      let status = "Configured";

      if (prov === "antigravity" && Array.isArray(agyAccounts.accounts)) {
        status = `OAuth (${agyAccounts.accounts.length} accounts)`;
      } else if (authEntry) {
        if (authEntry.type === "oauth") {
          const exp = authEntry.expires ? new Date(authEntry.expires) : null;
          const expired = exp ? exp.getTime() < Date.now() : false;
          const dateStr = exp ? exp.toISOString().slice(0, 10) : "unknown";
          status = expired ? `OAuth EXPIRED (${dateStr})` : `OAuth (valid until ${dateStr})`;
        } else if (authEntry.type === "api_key") {
          status = "API Key (active)";
        } else {
          status = String(authEntry.type ?? "active");
        }
      } else if (customModels.providers?.[prov]) {
        status = `Custom URL (${customModels.providers[prov].baseUrl ?? "models.json"})`;
      }

      rows.push(`${prov.padEnd(18)} | ${status} | ${count} models`);
    }

    if (rows.length === 0) {
      ctx.ui.notify("Chưa có provider nào được cấu hình.", "warning");
      return;
    }

    const picked = await ctx.ui.select("Providers & Login Status (Chọn để thao tác)", rows);
    if (!picked) return;

    const provName = picked.split("|")[0].trim();
    const action = await ctx.ui.select(`Provider: ${provName}`, [
      `Chọn Model của ${provName}`,
      `Đăng nhập / làm mới OAuth (/login ${provName})`,
      "Mở bảng cấu hình (/setup)",
    ]);
    if (!action) return;

    if (action.startsWith("Chọn Model")) {
      const models = available
        .filter((m) => m.provider === provName)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (models.length === 0) {
        ctx.ui.notify(`Provider ${provName} chưa có model khả dụng.`, "warning");
        return;
      }
      const pickedModel = await ctx.ui.select(
        `Provider: ${provName} — Chọn Model`,
        models.map((m) => `${m.id} [${m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "?"}]`),
      );
      if (!pickedModel) return;
      const modelId = pickedModel.split(/\s+/)[0];
      const target = models.find((m) => m.id === modelId);
      if (target) {
        await pi.setModel(target);
        ctx.ui.notify(`Đã chuyển sang ${target.provider}/${target.id}`, "info");
        activeTui?.requestRender();
      }
    } else if (action.startsWith("Đăng nhập")) {
      ctx.ui.setEditorText(`/login ${provName}`);
      ctx.ui.notify(`Đã điền /login ${provName} — nhấn Enter để đăng nhập`, "info");
    } else {
      await openSetupPanel(ctx);
    }
  }

  async function openModelStatsView(ctx: ExtensionCommandContext) {
    const all = ctx.modelRegistry
      .getAvailable()
      .filter((m) => m.provider !== "role" && m.provider !== "router");
    const stats = readJson(STATS_PATH) as Record<string, ModelPerfEntry>;

    const rows = all
      .sort((a, b) => {
        const keyA = `${a.provider}/${a.id}`;
        const keyB = `${b.provider}/${b.id}`;
        const callsA = stats[keyA]?.calls ?? 0;
        const callsB = stats[keyB]?.calls ?? 0;
        if (callsA !== callsB) return callsB - callsA;
        return keyA.localeCompare(keyB);
      })
      .map((m) => {
        const key = `${m.provider}/${m.id}`;
        const perf = stats[key];
        const ctxStr = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "?";
        const outStr = m.maxTokens ? `${Math.round(m.maxTokens / 1000)}k` : "?";
        const price = formatPriceTag(m);
        const speed = perf
          ? `avg ${perf.avgTokPerSec} tok/s (last ${perf.lastTokPerSec} tok/s, ${perf.calls} turns)`
          : "chưa đo (chưa chạy)";
        return `${key.padEnd(36)} | ctx:${ctxStr} out:${outStr} | ${price.padEnd(18)} | ${speed}`;
      });

    const picked = await ctx.ui.select(
      "Model Specs, Price ($in/$out per 1M) & Speed (tok/s) — Chọn để chuyển sang Model đó",
      rows,
    );
    if (!picked) return;

    const fullKey = picked.split("|")[0].trim();
    const slashIdx = fullKey.indexOf("/");
    if (slashIdx <= 0) return;
    const prov = fullKey.slice(0, slashIdx);
    const id = fullKey.slice(slashIdx + 1);
    const target = all.find((m) => m.provider === prov && m.id === id);
    if (target) {
      await pi.setModel(target);
      ctx.ui.notify(`Đã chuyển sang ${target.provider}/${target.id}`, "info");
      activeTui?.requestRender();
    }
  }

  async function openCommandHub(ctx: ExtensionCommandContext) {
    const categories = [
      "1. Cấu hình & Giao diện (Mở Control Panel /setup)",
      "2. Role, Model & Router (Đổi Role, Gán Model+Effort, Xem bảng Role)",
      "3. Code Review & Kiểm tra (Review diff, Advisor, Audit Piolium, Q&A)",
      "4. Công cụ, MCP & Tự hành (MCP Servers, Bật/tắt Tools, Goal)",
      "5. Phiên làm việc & Git (Checkpoint, Handoff, Bookmark, Duyệt toàn bộ lệnh)",
      "6. Hệ thống: Restart (Reload) hoặc Thoát Pi (Exit)",
    ];

    const chosenCat = await ctx.ui.select("Pi Command Hub — Chọn nhóm chức năng", categories);
    if (!chosenCat) return;

    if (chosenCat.startsWith("1.")) {
      await openSetupPanel(ctx);
      return;
    }

    type HubAction = { label: string; cmd: string; prefillOnly?: boolean };
    let actions: HubAction[] = [];

    if (chosenCat.startsWith("2.")) {
      actions = [
        { label: "Đổi nhanh Role hiện tại (/role)", cmd: "/role", prefillOnly: true },
        { label: "Chọn Model theo Provider kèm Giá & tok/s (/models)", cmd: "__MODELS__" },
        { label: "Xem bảng Tốc độ tok/s & Giá từng Model (/speed)", cmd: "__SPEED__" },
        { label: "Thống kê tổng Token & Chi phí theo ngày (/stats | /cost)", cmd: "__STATS__" },
        { label: "Xem hạn mức Quota ngày/tuần của Provider (/usage)", cmd: "/usage", prefillOnly: true },
        { label: "Xem Provider đã login & trạng thái Auth (/providers)", cmd: "__PROVIDERS__" },
        { label: "Gán Model + Effort cho từng Role (/role config)", cmd: "/role config", prefillOnly: true },
        { label: "Xem toàn bộ bảng ánh xạ Role -> Model (/roles)", cmd: "/roles", prefillOnly: true },
      ];
    } else if (chosenCat.startsWith("3.")) {
      actions = [
        { label: "Chạy Senior Code Review trên git diff (/review)", cmd: "/review", prefillOnly: true },
        { label: "Bật/Tắt Real-time Advisor (/advisor)", cmd: "/advisor", prefillOnly: true },
        { label: "Audit toàn diện repo với Piolium (/piolium-balanced)", cmd: "/piolium-balanced", prefillOnly: true },
        { label: "Trích xuất câu hỏi từ câu trả lời vừa rồi (/qna)", cmd: "/qna", prefillOnly: true },
      ];
    } else if (chosenCat.startsWith("4.")) {
      actions = [
        { label: "Quản lý MCP Servers & Tools (/mcp)", cmd: "/mcp", prefillOnly: true },
        { label: "Bật/tắt các công cụ đang hoạt động (/tools)", cmd: "/tools", prefillOnly: true },
        { label: "Chạy mục tiêu tự hành dài hạn (/goal)", cmd: "/goal ", prefillOnly: true },
      ];
    } else if (chosenCat.startsWith("5.")) {
      actions = [
        { label: "Tạo/khôi phục Git Checkpoint (/checkpoint)", cmd: "/checkpoint", prefillOnly: true },
        { label: "Chuyển giao ngữ cảnh sang phiên mới (/handoff)", cmd: "/handoff ", prefillOnly: true },
        { label: "Đánh dấu Bookmark trong phiên (/bookmark)", cmd: "/bookmark", prefillOnly: true },
        { label: "Xem danh sách toàn bộ lệnh mở rộng đang cài", cmd: "__ALL__" },
      ];
    } else if (chosenCat.startsWith("6.")) {
      actions = [
        { label: "Restart / Reload toàn bộ Extensions, Skills, Settings (/restart)", cmd: "__RESTART__" },
        { label: "Xoá màn hình & tạo phiên chat mới (/clear)", cmd: "/clear", prefillOnly: true },
        { label: "Thoát Pi an toàn (/exit)", cmd: "__EXIT__" },
      ];
    }

    const pickedLabel = await ctx.ui.select(
      chosenCat,
      actions.map((a) => a.label),
    );
    if (!pickedLabel) return;

    const action = actions.find((a) => a.label === pickedLabel);
    if (!action) return;

    if (action.cmd === "__MODELS__") {
      await openModelPicker(ctx);
      return;
    }
    if (action.cmd === "__SPEED__") {
      await openModelStatsView(ctx);
      return;
    }
    if (action.cmd === "__PROVIDERS__") {
      await openProvidersView(ctx);
      return;
    }
    if (action.cmd === "__STATS__") {
      await runStatsReport("", ctx);
      return;
    }
    if (action.cmd === "__RESTART__") {
      ctx.ui.notify("Đang khởi động lại Runtime (Extensions, Skills, Settings)...", "info");
      await ctx.reload();
      return;
    }
    if (action.cmd === "__EXIT__") {
      ctx.shutdown();
      return;
    }
    if (action.cmd === "__ALL__") {
      const allCmds = pi
        .getCommands()
        .filter((c) => c.source !== "skill")
        .map((c) => `/${c.name} — ${categorizeCommand(c.name, c.description)}`);
      const pickedCmd = await ctx.ui.select("Toàn bộ lệnh (không gồm Skills)", allCmds);
      if (pickedCmd) {
        const rawCmd = pickedCmd.split(" — ")[0].trim();
        ctx.ui.setEditorText(`${rawCmd} `);
      }
      return;
    }

    if (action.prefillOnly) {
      ctx.ui.setEditorText(action.cmd);
      ctx.ui.notify(`Đã điền ${action.cmd} vào ô nhập — nhấn Enter để chạy`, "info");
    } else {
      pi.sendUserMessage(action.cmd, { expandPromptTemplates: true });
    }
  }

  // 1. `/setup` command
  pi.registerCommand("setup", {
    description: "Bảng điều khiển tập trung: bật/tắt Role, Advisor, Thinking, HUD, Cache, UI",
    handler: async (_args, ctx) => {
      await openSetupPanel(ctx);
    },
  });

  // 2. `/menu` command (Categorized Command Hub)
  pi.registerCommand("menu", {
    description: "Menu phân nhóm toàn bộ chức năng (Role, Review, MCP, Git, Restart/Exit)",
    handler: async (_args, ctx) => {
      await openCommandHub(ctx);
    },
  });

  // 3. `/restart` command (Community favorite from reload-runtime.ts)
  pi.registerCommand("restart", {
    description: "Khởi động lại (reload) toàn bộ extensions, skills, settings, roles mà không mất phiên chat",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Đang nạp lại toàn bộ cấu hình, extensions & skills...", "info");
      await ctx.reload();
    },
  });

  // 4. `/models` & `/providers` commands + `Ctrl+L` / `Alt+L`: Provider-grouped Model Picker
  pi.registerCommand("models", {
    description: "Chọn Model phân nhóm theo từng Provider",
    handler: async (_args, ctx) => {
      await openModelPicker(ctx);
    },
  });

  pi.registerCommand("providers", {
    description: "Xem trạng thái login OAuth/API Key của các Provider và số model khả dụng",
    handler: async (_args, ctx) => {
      await openProvidersView(ctx);
    },
  });

  async function runStatsReport(args: string, ctx: ExtensionCommandContext): Promise<void> {
    try {
      const aggMod = await import("../lib/stats/aggregate.ts");
      const fmtMod = await import("../lib/stats/format.ts");
      const tokens = args.trim() ? args.trim().split(/\s+/) : [];
      const flags = new Set<string>();
      const positional: string[] = [];
      for (const tok of tokens) {
        if (tok.startsWith("-")) flags.add(tok);
        else positional.push(tok);
      }
      if (flags.has("--help") || flags.has("-h")) {
        ctx.ui.notify(
          "Usage: /stats (or /cost) [YYYY-MM-DD | A..B | A.. | ..B] [--project] [--daily] [--json]",
          "info",
        );
        return;
      }
      const range = aggMod.parseRange(positional[0]);
      const project = flags.has("--project") || flags.has("-p");
      const daily = flags.has("--daily") || flags.has("-d");
      const json = flags.has("--json");
      const dir = aggMod.defaultSessionsDir();
      const files = aggMod.collectSessionFiles(dir);
      if (files.length === 0) {
        ctx.ui.notify(`No session files found in: ${dir}`, "warning");
        return;
      }
      const result = aggMod.aggregate(files, {
        fromMs: range.fromMs,
        toMs: range.toMs,
        cwdFilter: project ? ctx.cwd : undefined,
      });
      result.rangeLabel = range.label;
      if (result.byModel.size === 0) {
        ctx.ui.notify(`No usage recorded for range (${range.label}).`, "info");
        return;
      }
      const text = json
        ? fmtMod.renderJson(result, { rangeLabel: range.label, project: project ? ctx.cwd : undefined, daily })
        : fmtMod.renderReport(result, { rangeLabel: range.label, project: project ? ctx.cwd : undefined, daily });
      ctx.ui.notify(text, "info");
    } catch (err) {
      ctx.ui.notify(`Stats error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  pi.registerCommand("speed", {
    description: "Xem tốc độ tok/s thực tế, giá tiền ($in/$out/cache per 1M) và thông số kỹ thuật từng Model",
    handler: async (_args, ctx) => {
      await openModelStatsView(ctx);
    },
  });

  pi.registerCommand("stats", {
    description: "Token & cost usage report — /stats [YYYY-MM-DD|A..B] [--project] [--daily] [--json]",
    handler: async (args, ctx) => {
      await runStatsReport(args, ctx);
    },
  });

  pi.registerCommand("cost", {
    description: "Alias cho /stats — thống kê token và chi phí theo model/ngày",
    handler: async (args, ctx) => {
      await runStatsReport(args, ctx);
    },
  });

  pi.registerShortcut(Key.ctrl("l"), {
    description: "Open Provider-grouped Model Picker (/models)",
    handler: async (ctx) => {
      await openModelPicker(ctx as unknown as ExtensionCommandContext);
    },
  });

  pi.registerShortcut(Key.alt("l"), {
    description: "Open Provider-grouped Model Picker (/models)",
    handler: async (ctx) => {
      await openModelPicker(ctx as unknown as ExtensionCommandContext);
    },
  });

  // 5. `/exit` command (Pi already has built-in `/quit`)
  pi.registerCommand("exit", {
    description: "Thoát Pi an toàn",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // 5. Shortcuts: `Alt+M` -> Command Hub (/menu), `Alt+S` -> Control Panel (/setup)
  pi.registerShortcut(Key.alt("m"), {
    description: "Open Pi Categorized Command Hub (/menu)",
    handler: async (ctx) => {
      await openCommandHub(ctx as unknown as ExtensionCommandContext);
    },
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Open Pi Control Panel (/setup)",
    handler: async (ctx) => {
      await openSetupPanel(ctx as unknown as ExtensionCommandContext);
    },
  });

  // 6. Initialize HUD Editor & Custom `/` Autocomplete on `session_start`
  pi.on("session_start", (_event, ctx) => {
    const settings = readJson(SETTINGS_PATH);
    if (settings.detailedHud !== false) {
      applyHudEditor(ctx, true);
      // Re-apply after package session_start hooks (e.g. @vigolium/piolium) so DetailedHudEditor stays active
      setImmediate(() => {
        if (readJson(SETTINGS_PATH).detailedHud !== false) {
          applyHudEditor(ctx, true);
        }
      });
    }

    void pi
      .exec("git", ["branch", "--show-current"], { cwd: ctx.cwd })
      .then((res) => {
        const b = res.stdout.trim();
        gitBranch = b || undefined;
        activeTui?.requestRender();
      })
      .catch(() => undefined);

    ctx.ui.addAutocompleteProvider((current: AutocompleteProvider): AutocompleteProvider => ({
      async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
        const currentLine = lines[cursorLine] ?? "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        const trimmed = textBeforeCursor.trimStart();

        // When user just typed `/` with nothing after it -> show curated 11-item Quick Menu
        if (!options.force && trimmed === "/") {
          return {
            prefix: "/",
            items: PINNED_SLASH_ITEMS,
          };
        }

        const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!base || !trimmed.startsWith("/")) {
          return base;
        }

        // If user is typing `/<query>`:
        // - hide `skill:` unless query starts with `skill`
        // - hide `subagents-*` unless query explicitly mentions `sub` or `profile`
        // - prefer direct substring matches over loose fuzzy matches (e.g. `/role` -> only `role`, `roles`)
        const query = trimmed.slice(1).toLowerCase();
        const showSkills = query.startsWith("skill");
        const showSubagents = query.includes("sub") || query.includes("profile");

        let filtered = base.items.filter(
          (item) =>
            item.value !== "model" &&
            (showSkills || !item.value.startsWith("skill:")) &&
            (showSubagents || !item.value.startsWith("subagents-")),
        );

        const directMatches = filtered.filter((item) => item.value.toLowerCase().includes(query));
        if (directMatches.length > 0) {
          filtered = directMatches;
        }

        const enhancedItems = filtered
          .slice(0, 15)
          .map((item) => ({
            ...item,
            description: categorizeCommand(item.value, item.description),
          }));

        if (enhancedItems.length === 0) return base;
        return {
          prefix: base.prefix,
          items: enhancedItems,
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
    }));
  });
}

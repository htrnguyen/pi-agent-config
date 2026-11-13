/**
 * pi-stats — 순수 집계 로직 (pi 런타임 의존 없음)
 *
 * pi 세션 JSONL(~/.pi/agent/sessions/**)에서 LLM usage 레코드를 읽어
 * 모델별/일자별로 합산한다.
 *
 * 세션 포맷(docs/session-format.md v3) 기준 카운트 대상:
 *   - { type: "message", message: { role: "assistant", usage } }
 *   - { type: "message", message: { role: "toolResult", usage? } }  (툴 내부 LLM 호출)
 *   - { type: "compaction" | "branch_summary", usage? }             (요약 생성 비용)
 *   - type 필드 없이 중첩 message.usage만 있는 레코드
 *     (subagent-artifacts/*_worker_*_transcript.jsonl 등 서브에이전트 기록)
 *
 * 카운트하지 않는 것:
 *   - compaction.retainedTail 안의 메시지 (세션 앞부분의 복사본 — 중복 방지)
 *   - user / 기타 엔트리
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";

export interface Bucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	requests: number;
}

export interface UsageRange {
	fromMs: number; // 포함 하한 (Infinity 여도 무방)
	toMs: number; // 제외 상한
	label: string;
}

export interface AggregateOptions {
	fromMs?: number;
	toMs?: number;
	/** 지정하면 세션 헤더의 cwd가 정확히 일치하는 세션만 집계 */
	cwdFilter?: string;
}

export interface AggregateResult {
	rangeLabel: string;
	byModel: Map<string, Bucket>;
	/** 로컬 타임존 날짜 키(YYYY-MM-DD) → 모델 → bucket */
	byDay: Map<string, Map<string, Bucket>>;
	filesScanned: number;
	sessionsMatched: number;
}

const SUMMARY_KEY = "(summary)";
const TOOLS_KEY = "(tools)";

// ── 날짜 파싱 (로컬 타임존) ────────────────────────────────────────────

function dayStartMs(dateStr: string): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		throw new Error(`Invalid date format: ${dateStr} (expected YYYY-MM-DD)`);
	}
	const [y, m, d] = dateStr.split("-").map(Number);
	const ms = new Date(y, m - 1, d).getTime();
	// 존재하지 않는 날짜(예: 2026-02-31) 거르기
	const check = new Date(ms);
	if (
		check.getFullYear() !== y ||
		check.getMonth() !== m - 1 ||
		check.getDate() !== d
	) {
		throw new Error(`Invalid calendar date: ${dateStr}`);
	}
	return ms;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function localDayKey(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 기간 인자를 파싱한다. 모두 로컬 타임존 기준.
 *   (없음) | "."      오늘
 *   2026-08-21        그날 하루
 *   A..B              A 00:00 ~ B 23:59:59.999 (양끝 날짜 포함)
 *   A..               A 00:00 ~ 지금 이후(무제한)
 *   ..B               무제한 ~ B 하루 끝까지
 */
export function parseRange(spec?: string): UsageRange {
	const empty = spec === undefined || spec.trim() === "";
	if (!empty && !spec!.includes("..")) {
		const from = dayStartMs(spec!.trim());
		return {
			fromMs: from,
			toMs: from + DAY_MS,
			label: spec!.trim(),
		};
	}
	const today = localDayKey(Date.now());
	if (empty || spec!.trim() === ".") {
		const from = dayStartMs(today);
		return { fromMs: from, toMs: from + DAY_MS, label: `Today (${today})` };
	}
	const [a, b] = spec!.split("..");
	const hasA = a !== undefined && a.trim() !== "";
	const hasB = b !== undefined && b.trim() !== "";
	if (!hasA && !hasB) throw new Error("Empty date range. Example: 2026-08-01..2026-08-07");
	if (hasA && hasB) {
		const from = dayStartMs(a.trim());
		const to = dayStartMs(b.trim());
		if (from > to) throw new Error(`Start date is after end date: ${spec}`);
		return {
			fromMs: from,
			toMs: to + DAY_MS,
			label: `${a.trim()} ~ ${b.trim()}`,
		};
	}
	if (hasA) {
		return {
			fromMs: dayStartMs(a.trim()),
			toMs: Number.POSITIVE_INFINITY,
			label: `${a.trim()} ~ now`,
		};
	}
	const to = dayStartMs(b!.trim());
	return { fromMs: Number.NEGATIVE_INFINITY, toMs: to + DAY_MS, label: `start ~ ${b!.trim()}` };
}

// ── 세션 파일 수집 ─────────────────────────────────────────────────────

export function defaultSessionsDir(): string {
	return process.env.PI_STATS_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

export function collectSessionFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // 권한 없음 등 — 건너뜀
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
		}
	};
	if (!existsSync(root)) return out;
	walk(root);
	return out;
}

// ── 집계 ──────────────────────────────────────────────────────────────

function emptyBucket(): Bucket {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		requests: 0,
	};
}

function addBucket(target: Map<string, Bucket>, key: string, b: Bucket): void {
	const cur = target.get(key);
	if (!cur) target.set(key, { ...b }); // 복사본 저장 — 동일 객체가 byModel/byDay에 공유되면 이중 증가됨
	else {
		cur.input += b.input;
		cur.output += b.output;
		cur.cacheRead += b.cacheRead;
		cur.cacheWrite += b.cacheWrite;
		cur.totalTokens += b.totalTokens;
		cur.cost += b.cost;
		cur.requests += b.requests;
	}
}

function normalize(u: Record<string, unknown>): Bucket {
	const cost = (u.cost ?? {}) as Record<string, number>;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const input = num(u.input);
	const output = num(u.output);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	const total =
		num(u.totalTokens) || input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: total,
		cost: num(cost.total),
		requests: 1,
	};
}

interface CountedEntry {
	tsMs: number;
	key: string;
	usage: Record<string, unknown>;
}

/** JSONL 한 줄에서 집계 대상 (ts, modelKey, usage) 추출. 대상 아니면 null */
function extractCounted(entry: Record<string, unknown>): CountedEntry | null {
	const type = entry.type as string | undefined;
	if (type === "compaction" || type === "branch_summary") {
		const usage = entry.usage as Record<string, unknown> | undefined;
		if (!usage || typeof usage !== "object") return null;
		return { tsMs: resolveTs(entry), key: SUMMARY_KEY, usage };
	}
	// message 후보: type === "message" 뿐 아니라 type 없이 중첩 message만 있는
	// 레코드도 취급한다 (subagent-artifacts/*_worker_*_transcript.jsonl 등)
	const msg = entry.message as Record<string, unknown> | undefined;
	if (!msg || typeof msg !== "object") return null;
	const role = msg.role as string | undefined;
	const usage = msg.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return null;
	let key: string;
	if (role === "assistant") {
		const provider = (msg.provider as string) || "?";
		const model = (msg.model as string) || "?";
		key = `${provider}/${model}`;
	} else if (role === "toolResult") {
		key = TOOLS_KEY;
	} else {
		return null;
	}
	return { tsMs: resolveTs(entry, msg), key, usage };
}

function resolveTs(
	entry: Record<string, unknown>,
	msg?: Record<string, unknown>,
): number {
	if (typeof entry.timestamp === "string") {
		const t = Date.parse(entry.timestamp);
		if (Number.isFinite(t)) return t;
	}
	if (msg && typeof msg.timestamp === "number") return msg.timestamp;
	if (typeof entry.timestamp === "number") return entry.timestamp;
	return Number.NaN;
}

export function aggregate(files: string[], opts: AggregateOptions = {}): AggregateResult {
	const fromMs = opts.fromMs ?? Number.NEGATIVE_INFINITY;
	const toMs = opts.toMs ?? Number.POSITIVE_INFINITY;
	const byModel = new Map<string, Bucket>();
	const byDay = new Map<string, Map<string, Bucket>>();
	let filesScanned = 0;
	let sessionsMatched = 0;

	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (raw.length === 0) continue;
		filesScanned++;

		// --project 필터: 첫 줄(session 헤더)의 cwd 비교
		if (opts.cwdFilter) {
			const nl = raw.indexOf("\n");
			const headerLine = nl === -1 ? raw : raw.slice(0, nl);
			try {
				const header = JSON.parse(headerLine) as Record<string, unknown>;
				if (header.type !== "session" || header.cwd !== opts.cwdFilter) continue;
			} catch {
				continue;
			}
		}

		let matchedInFile = false;
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue; // 손상된 줄 무시
			}
			const counted = extractCounted(parsed);
			if (!counted) continue;
			const { tsMs, key, usage } = counted;
			if (!Number.isFinite(tsMs)) continue;
			if (tsMs < fromMs || tsMs >= toMs) continue;

			matchedInFile = true;
			const b = normalize(usage);
			addBucket(byModel, key, b);
			const dayKey = localDayKey(tsMs);
			let dayMap = byDay.get(dayKey);
			if (!dayMap) {
				dayMap = new Map();
				byDay.set(dayKey, dayMap);
			}
			addBucket(dayMap, key, b);
		}
		if (matchedInFile) sessionsMatched++;
	}

	return { rangeLabel: "", byModel, byDay, filesScanned, sessionsMatched };
}

export function sumBuckets(map: Map<string, Bucket>): Bucket {
	const total = emptyBucket();
	for (const b of map.values()) {
		total.input += b.input;
		total.output += b.output;
		total.cacheRead += b.cacheRead;
		total.cacheWrite += b.cacheWrite;
		total.totalTokens += b.totalTokens;
		total.cost += b.cost;
		total.requests += b.requests;
	}
	return total;
}

export { SUMMARY_KEY, TOOLS_KEY };

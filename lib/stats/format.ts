/**
 * pi-stats — 출력 포매팅 (테이블 / 일자별 / JSON)
 */
import { sumBuckets, TOOLS_KEY, SUMMARY_KEY } from "./aggregate.ts";
import type { AggregateResult } from "./aggregate.ts";

const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
const fmtCost = (n: number): string => `$${n.toFixed(4)}`;

function column(rows: string[][]): string {
	// rows[r][c] — 마지막 열 제외 오른쪽 2칸 패딩, 각 열은 셀 최대 폭에 맞춤
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length);
		});
	}
	return rows
		.map((row) =>
			row
				.map((cell, i) =>
					i === row.length - 1 ? cell : cell + " ".repeat(widths[i] - cell.length),
				)
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

export interface ReportOptions {
	rangeLabel: string;
	project?: string;
	daily: boolean;
}

export function renderReport(result: AggregateResult, opts: ReportOptions): string {
	const lines: string[] = [];

	// ── 모델별 테이블 ──
	const total = sumBuckets(result.byModel);
	const models = [...result.byModel.entries()].sort(
		(a, b) => b[1].totalTokens - a[1].totalTokens,
	);

	const shortModel = (name: string) => {
		if (name === TOOLS_KEY) return "(tool internal LLM)";
		if (name === SUMMARY_KEY) return "(compaction/summary)";
		return name.length > 34 ? `${name.slice(0, 31)}...` : name;
	};

	const header = ["Model", "input", "output", "cacheRead", "total", "cost", "req"];
	const body: string[][] = [
		header,
		header.map(() => "--------"),
		...models.map(([name, b]) => [
			shortModel(name),
			fmtInt(b.input),
			fmtInt(b.output),
			fmtInt(b.cacheRead),
			fmtInt(b.totalTokens),
			fmtCost(b.cost),
			String(b.requests),
		]),
		[
			"Total",
			fmtInt(total.input),
			fmtInt(total.output),
			fmtInt(total.cacheRead),
			fmtInt(total.totalTokens),
			fmtCost(total.cost),
			String(total.requests),
		],
	];

	lines.push(`Pi Usage Report — ${opts.rangeLabel}`);
	if (opts.project) lines.push(`Project: ${opts.project}`);
	lines.push(
		`Sessions matched: ${result.sessionsMatched}/${result.filesScanned} files (local timezone)`,
	);
	lines.push("");
	lines.push(column(body));

	// ── Daily breakdown ──
	if (opts.daily && result.byDay.size > 0) {
		const days = [...result.byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
		const dHeader = ["Date", "input", "output", "cacheRead", "total", "cost"];
		const dBody: string[][] = [
			dHeader,
			dHeader.map(() => "--------"),
			...days.map(([day, map]) => {
				const t = sumBuckets(map);
				return [
					day,
					fmtInt(t.input),
					fmtInt(t.output),
					fmtInt(t.cacheRead),
					fmtInt(t.totalTokens),
					fmtCost(t.cost),
				];
			}),
			[
				"Total",
				fmtInt(total.input),
				fmtInt(total.output),
				fmtInt(total.cacheRead),
				fmtInt(total.totalTokens),
				fmtCost(total.cost),
			],
		];
		lines.push("");
		lines.push("Daily Breakdown");
		lines.push(column(dBody));
	}

	return lines.join("\n");
}

export function renderJson(result: AggregateResult, opts: ReportOptions): string {
	const total = sumBuckets(result.byModel);
	const payload = {
		range: opts.rangeLabel,
		project: opts.project ?? null,
		filesScanned: result.filesScanned,
		sessionsMatched: result.sessionsMatched,
		totals: total,
		models: [...result.byModel.entries()]
			.sort((a, b) => b[1].totalTokens - a[1].totalTokens)
			.map(([model, b]) => ({ model, ...b })),
		days: opts.daily
			? [...result.byDay.entries()]
					.sort((a, b) => (a[0] < b[0] ? -1 : 1))
					.map(([date, map]) => ({ date, totals: sumBuckets(map), models: Object.fromEntries(map) }))
			: undefined,
	};
	return JSON.stringify(payload, null, 2);
}

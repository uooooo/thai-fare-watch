import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FareObservation, Itinerary, SourceHealth } from "../types";
import { addDays, monthsTouched, todayJst } from "../util/dates";

export type StateFile = {
	lastRuns: Record<string, string>; // jobId -> ISO8601
	rssSeen: Record<string, string[]>; // feed -> guid[]（直近200件で切詰め）
	breakers: Record<string, { openUntil?: string; failures: number }>;
	verifyQueue: string[]; // Itinerary.id（ローカル昇格待ち）
};

function emptyState(): StateFile {
	return { lastRuns: {}, rssSeen: {}, breakers: {}, verifyQueue: [] };
}

// obs.foundAtはISO8601(UTC)。appendFaresはslice(0,7)でそのまま月ファイル名にするため、
// 「当月」もnowのUTC日付基準で揃える（JSTには寄せない）。
function currentAndPreviousMonths(now: Date): string[] {
	const today = now.toISOString().slice(0, 10);
	const firstOfMonth = `${today.slice(0, 7)}-01`;
	const lastOfPrevMonth = addDays(firstOfMonth, -1);
	return monthsTouched({ from: lastOfPrevMonth, to: today });
}

function currentJstMonth(): string {
	return todayJst().slice(0, 7);
}

export class Store {
	private readonly dataDir: string;

	constructor(dataDir: string = "data") {
		this.dataDir = dataDir;
	}

	private path(relPath: string): string {
		return join(this.dataDir, relPath);
	}

	private ensureDataDir(): void {
		mkdirSync(this.dataDir, { recursive: true });
	}

	private readJson<T>(relPath: string, fallback: () => T): T {
		const p = this.path(relPath);
		if (!existsSync(p)) return fallback();
		return JSON.parse(readFileSync(p, "utf8")) as T;
	}

	private writeJson(relPath: string, value: unknown): void {
		this.ensureDataDir();
		writeFileSync(this.path(relPath), JSON.stringify(value, null, 2));
	}

	private readJsonl<T>(relPath: string): T[] {
		const p = this.path(relPath);
		if (!existsSync(p)) return [];
		const out: T[] = [];
		for (const line of readFileSync(p, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				out.push(JSON.parse(line) as T);
			} catch {
				// 壊れた行は無視する
			}
		}
		return out;
	}

	readState(): StateFile {
		return this.readJson<StateFile>("state.json", emptyState);
	}
	writeState(s: StateFile): void {
		this.writeJson("state.json", s);
	}

	appendFares(obs: FareObservation[]): void {
		const byMonth = new Map<string, FareObservation[]>();
		for (const o of obs) {
			const month = o.foundAt.slice(0, 7);
			const list = byMonth.get(month);
			if (list) list.push(o);
			else byMonth.set(month, [o]);
		}
		if (byMonth.size === 0) return;
		mkdirSync(this.path("fares"), { recursive: true });
		for (const [month, list] of byMonth) {
			const lines = list.map((o) => `${JSON.stringify(o)}\n`).join("");
			appendFileSync(this.path(join("fares", `${month}.jsonl`)), lines);
		}
	}

	readRecentFares(hours: number, now?: Date): FareObservation[] {
		const base = now ?? new Date();
		const cutoff = base.getTime() - hours * 3_600_000;
		const out: FareObservation[] = [];
		for (const month of currentAndPreviousMonths(base)) {
			const rows = this.readJsonl<FareObservation>(
				join("fares", `${month}.jsonl`),
			);
			for (const o of rows) {
				if (new Date(o.foundAt).getTime() >= cutoff) out.push(o);
			}
		}
		return out;
	}

	readDeals(): Itinerary[] {
		return this.readJson<Itinerary[]>("deals.json", () => []);
	}
	writeDeals(deals: Itinerary[]): void {
		this.writeJson("deals.json", deals);
	}

	readQuota(): { month: string; used: number } {
		const current = currentJstMonth();
		const stored = this.readJson<{ month: string; used: number }>(
			"quota.json",
			() => ({ month: current, used: 0 }),
		);
		if (stored.month !== current) return { month: current, used: 0 };
		return stored;
	}
	writeQuota(q: { month: string; used: number }): void {
		this.writeJson("quota.json", q);
	}

	appendNotified(entry: object): void {
		this.ensureDataDir();
		appendFileSync(this.path("notified.jsonl"), `${JSON.stringify(entry)}\n`);
	}
	readNotified(): Record<
		string,
		{ priceJpy: number; at: string; tier: string }
	> {
		type Row = { dealKey: string; priceJpy: number; at: string; tier: string };
		const out: Record<string, { priceJpy: number; at: string; tier: string }> =
			{};
		for (const row of this.readJsonl<Row>("notified.jsonl")) {
			out[row.dealKey] = {
				priceJpy: row.priceJpy,
				at: row.at,
				tier: row.tier,
			};
		}
		return out;
	}

	readHealth(): Record<string, SourceHealth> {
		return this.readJson<Record<string, SourceHealth>>(
			"health.json",
			() => ({}),
		);
	}
	writeHealth(h: Record<string, SourceHealth>): void {
		this.writeJson("health.json", h);
	}
}

// dryRun専用ラッパ(C1)。makeCiBreaker(fliのCB状態)やSerpApiSourceのQuotaManagerのように、
// ソース実装内部がpipelineの`!dryRun`ガードを経由せず直接Storeへ書き込むコードパスがある。
// dryRun実行中にこれらが実ディスク(state.json/quota.json)を書き換えてしまうと、例えば
// fliが3回失敗するだけでdryRun runからでも本物のCIサーキットブレーカが6時間openしてしまう。
// 読み取り系は全て実storeへ委譲(dryRunでも直近の状態は正しく見える)。書き込み系
// (writeState/writeQuota/writeDeals/writeHealth/appendFares/appendNotified)は全てno-op。
class DryRunStore extends Store {
	constructor(private readonly inner: Store) {
		super();
	}

	override readState(): StateFile {
		return this.inner.readState();
	}
	override writeState(_s: StateFile): void {}

	override appendFares(_obs: FareObservation[]): void {}
	override readRecentFares(hours: number, now?: Date): FareObservation[] {
		return this.inner.readRecentFares(hours, now);
	}

	override readDeals(): Itinerary[] {
		return this.inner.readDeals();
	}
	override writeDeals(_deals: Itinerary[]): void {}

	override readQuota(): { month: string; used: number } {
		return this.inner.readQuota();
	}
	override writeQuota(_q: { month: string; used: number }): void {}

	override appendNotified(_entry: object): void {}
	override readNotified(): Record<
		string,
		{ priceJpy: number; at: string; tier: string }
	> {
		return this.inner.readNotified();
	}

	override readHealth(): Record<string, SourceHealth> {
		return this.inner.readHealth();
	}
	override writeHealth(_h: Record<string, SourceHealth>): void {}
}

// dryRun呼び出し元は、pipeline.runWatchOnceにdryRun:trueを渡すだけでは不十分 —
// ソース内部が直接触るStore(fliのCB/SerpAPIのクォータ等)を守るには、この関数で包んだ
// Storeをソースへ渡す側(例: buildSources)にも明示的にdryRunを伝える必要がある。
export function makeDryRunStore(store: Store): Store {
	return new DryRunStore(store);
}

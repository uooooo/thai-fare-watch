import type { Config } from "../config";
import type { Store } from "../state/store";
import type {
	DateRange,
	FareObservation,
	OdPair,
	VerifiedOffer,
} from "../types";
import { stableId } from "../util/hash";
import type { FareSource, RunnerEnv } from "./types";

// ---- 確定したCLI契約 (Step 1: punitarani/fli, README + 実uvx検証) --------------
// pip配布名は `flights`、CLIエントリポイントは `fli`。
// `flights` は click を直接importするが依存に宣言しておらず、uvxのPython 3.14/3.12
// どちらでも `ModuleNotFoundError: No module named 'click'` になる。`--with click`
// で注入すると解決する。よって既定の実体コマンドは:
//   uvx --from flights --with click fli <args...>
const UVX_BASE = ["uvx", "--from", "flights", "--with", "click", "fli"];
const SUBPROCESS_TIMEOUT_MS = 30_000;
// JPY / 日本POS。currency未指定だとUSD既定になるため必ず付与する。
const LOCALE_ARGS = ["--currency", "JPY", "--country", "JP"];

export type RunResult = { exitCode: number; stdout: string; stderr: string };
export type RunFn = (args: string[]) => Promise<RunResult>;
export type Breaker = {
	isOpen(): boolean;
	recordFailure(): void;
	recordSuccess(): void;
};

type FliDeps = { run?: RunFn; breaker?: Breaker; now?: Date };

// `fli flights <origin> <dest> <date> ...` の引数（verify=単日ライブ検索）。
export function flightsArgs(od: OdPair, date: string): string[] {
	return [
		"flights",
		od.origin,
		od.destination,
		date,
		...LOCALE_ARGS,
		"--stops",
		"ANY",
		"--sort",
		"CHEAPEST",
		"--format",
		"json",
	];
}

// `fli dates <origin> <dest> --from --to ...` の引数（sweep=ネイティブ日付範囲）。
export function datesArgs(pair: OdPair, range: DateRange): string[] {
	return [
		"dates",
		pair.origin,
		pair.destination,
		"--from",
		range.from,
		"--to",
		range.to,
		...LOCALE_ARGS,
		"--sort", // 価格昇順（最安スキャン）。dates側は値なしフラグ。
		"--format",
		"json",
	];
}

// ---- fli --format json のレスポンス形状（Step 1で実採取した形） ----------------
type FliAirport = { code: string; name?: string };
type FliLeg = {
	departure_airport: FliAirport;
	arrival_airport: FliAirport;
	departure_time: string; // "2026-08-18T17:00:00"（オフセットなし現地時刻）
	arrival_time: string;
	airline: { code: string; name?: string };
	flight_number: string;
};
type FliFlight = {
	stops?: number;
	legs?: FliLeg[];
	price?: number | null; // 実出力では未確定行が price:null で返る
	currency?: string | null;
};
type FliFlightsResponse = { success?: boolean; flights?: FliFlight[] };
type FliDateEntry = {
	departure_date: string;
	price?: number | null;
	currency?: string | null;
};
type FliDatesResponse = { success?: boolean; dates?: FliDateEntry[] };

// 既定run: uvxサブプロセス。30sでkillしstdout/stderr/exitCodeを収集する。
async function defaultRun(args: string[]): Promise<RunResult> {
	const proc = Bun.spawn([...UVX_BASE, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const killer = setTimeout(() => {
		proc.kill();
	}, SUBPROCESS_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(killer);
	}
}

function noopBreaker(): Breaker {
	return {
		isOpen: () => false,
		recordFailure: () => {},
		recordSuccess: () => {},
	};
}

// 正の有限数のみ有効価格。null/欠落/0/NaNは不完全行としてスキップ対象。
function isValidPrice(p: unknown): p is number {
	return typeof p === "number" && Number.isFinite(p) && p > 0;
}

function isJpyCurrency(currency: string | null | undefined): boolean {
	return currency === "JPY";
}

// 価格付き行はあったが1件もJPYが取れなかった場合のみ「全滅」としてthrowする
// （--currency JPY フラグが上流で無視された等のシグナル）。単発の混入行は
// 呼び出し側が個別スキップ済みなので、ここでは全滅判定のみを行う。
function assertNotAllNonJpy(
	pricedCount: number,
	collectedCount: number,
	nonJpyCount: number,
	observedCurrency: string | undefined,
): void {
	if (pricedCount > 0 && collectedCount === 0 && nonJpyCount > 0) {
		throw new Error(
			`fli: no JPY rows (currency=${observedCurrency}, ${nonJpyCount} rows skipped)`,
		);
	}
}

export class FliSource implements FareSource {
	name = "fli";
	private readonly cfg: Config;
	private readonly run: RunFn;
	private readonly breaker: Breaker;
	private readonly now: () => Date;

	constructor(cfg: Config, deps: FliDeps = {}) {
		this.cfg = cfg;
		this.run = deps.run ?? defaultRun;
		this.breaker = deps.breaker ?? noopBreaker();
		const fixedNow = deps.now;
		this.now = () => fixedNow ?? new Date();
	}

	available(_env: RunnerEnv): boolean {
		return this.cfg.fli.enabled && !this.breaker.isOpen();
	}

	// 単日ライブ検索 → VerifiedOffer[]（sellers=[]、失効時刻なし）。
	async verify(od: OdPair, date: string): Promise<VerifiedOffer[]> {
		try {
			const res = await this.run(flightsArgs(od, date));
			if (res.exitCode !== 0) {
				throw new Error(
					`fli flights exited ${res.exitCode}: ${res.stderr.trim()}`,
				);
			}
			const offers = this.parseFlights(od, date, res.stdout);
			this.breaker.recordSuccess();
			return offers;
		} catch (err) {
			this.breaker.recordFailure();
			throw err;
		}
	}

	// 日付範囲の最安スキャン。fliはネイティブの`fli dates`を持つのでそれを使う
	// （1ペア1コール。詳細leg情報は返らないため、便名/時刻/乗継はverifyで取得する）。
	async sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]> {
		const out: FareObservation[] = [];
		let attempted = 0;
		let anySucceeded = false;
		let lastErr: unknown;
		for (const pair of pairs) {
			attempted++;
			try {
				const res = await this.run(datesArgs(pair, range));
				if (res.exitCode !== 0) {
					throw new Error(
						`fli dates exited ${res.exitCode}: ${res.stderr.trim()}`,
					);
				}
				for (const obs of this.parseDates(pair, res.stdout)) out.push(obs);
				anySucceeded = true;
			} catch (err) {
				lastErr = err;
				console.warn(
					`fli: sweep failed for ${pair.origin}->${pair.destination}`,
					err,
				);
			}
		}
		if (attempted > 0 && !anySucceeded) {
			this.breaker.recordFailure();
			throw new Error(`fli: all sweep requests failed: ${String(lastErr)}`);
		}
		if (anySucceeded) this.breaker.recordSuccess();
		return out;
	}

	private parseFlights(
		od: OdPair,
		date: string,
		stdout: string,
	): VerifiedOffer[] {
		const parsed = JSON.parse(stdout) as FliFlightsResponse;
		if (parsed.success === false || !Array.isArray(parsed.flights)) {
			throw new Error("fli: unexpected flights payload");
		}
		const foundAt = this.now().toISOString();
		const out: VerifiedOffer[] = [];
		let pricedCount = 0;
		let nonJpyCount = 0;
		let observedCurrency: string | undefined;
		for (const f of parsed.flights) {
			const legs = f.legs;
			if (!Array.isArray(legs) || legs.length === 0) continue;
			const first = legs[0];
			const last = legs[legs.length - 1];
			if (!first || !last) continue;
			// 不完全行（price:null等）は個別にスキップし、残りの良行は活かす。
			if (!isValidPrice(f.price)) continue;
			pricedCount++;
			// 価格付き行がnon-JPYなら個別スキップ（サイレントUSD変換は防ぐ）。
			// 全滅（JPY行が1件も取れない）場合のみループ後にthrowする。
			if (!isJpyCurrency(f.currency)) {
				nonJpyCount++;
				observedCurrency ??= f.currency ?? "<none>";
				continue;
			}
			const origin = first.departure_airport.code;
			const destination = last.arrival_airport.code;
			const flightNumber = legs
				.map((l) => `${l.airline.code}${l.flight_number}`)
				.join("+");
			const priceJpy = Math.round(f.price);
			const departDate = first.departure_time.slice(0, 10) || date;
			out.push({
				id: stableId("fli", origin, destination, date, flightNumber, priceJpy),
				source: "fli",
				origin,
				destination,
				departDate,
				departAt: first.departure_time,
				arriveAt: last.arrival_time,
				airline: first.airline.code,
				flightNumber,
				transfers: f.stops ?? legs.length - 1,
				priceJpy,
				market: od.market,
				foundAt,
				sellers: [],
			});
		}
		// 価格付き行はあったが1件もJPYが取れなければ全滅としてthrow。
		// 有効行が0でも（non-JPY混入がなければ）「空の成功」とみなしthrowしない。
		assertNotAllNonJpy(pricedCount, out.length, nonJpyCount, observedCurrency);
		return out;
	}

	private parseDates(pair: OdPair, stdout: string): FareObservation[] {
		const parsed = JSON.parse(stdout) as FliDatesResponse;
		if (parsed.success === false || !Array.isArray(parsed.dates)) {
			throw new Error("fli: unexpected dates payload");
		}
		const foundAt = this.now().toISOString();
		const out: FareObservation[] = [];
		let pricedCount = 0;
		let nonJpyCount = 0;
		let observedCurrency: string | undefined;
		for (const d of parsed.dates) {
			if (!isValidPrice(d.price)) continue; // 不完全行はスキップ
			pricedCount++;
			// 価格付き行がnon-JPYなら個別スキップ。全滅時のみループ後にthrow。
			if (!isJpyCurrency(d.currency)) {
				nonJpyCount++;
				observedCurrency ??= d.currency ?? "<none>";
				continue;
			}
			const departDate = d.departure_date;
			const priceJpy = Math.round(d.price);
			// ネイティブdatesはleg詳細を返さない: transfersは0プレースホルダ、
			// 便名/時刻はundefined（詳細はverifyで取得）。
			out.push({
				id: stableId(
					"fli",
					pair.origin,
					pair.destination,
					departDate,
					undefined,
					priceJpy,
				),
				source: "fli",
				origin: pair.origin,
				destination: pair.destination,
				departDate,
				transfers: 0,
				priceJpy,
				market: pair.market,
				foundAt,
			});
		}
		// 価格付き行はあったが1件もJPYが取れなければ全滅としてthrow。
		assertNotAllNonJpy(pricedCount, out.length, nonJpyCount, observedCurrency);
		return out;
	}
}

// CIサーキットブレーカ。state.breakers.fli を読み書きする。
// CI(env.isCI): recordFailureでfailures++、閾値到達でopenUntil=now+cooldown。
//   isOpen()=openUntil設定済み && now<openUntil。満了後はclose扱い（次のsuccessで
//   failuresリセット）。recordSuccessでfailures=0かつopenUntilクリア。
// 非CI: 決してopenしない（isOpenは常にfalse）がfailuresは追跡する。
// 各変更後にwriteStateで永続化する。
export function makeCiBreaker(
	store: Store,
	cfg: Config,
	env: RunnerEnv,
): Breaker {
	const key = "fli";
	const { consecutive_failures, cooldown_hours } = cfg.fli.ci_circuit_breaker;

	const read = (): { openUntil?: string; failures: number } =>
		store.readState().breakers[key] ?? { failures: 0 };
	const write = (b: { openUntil?: string; failures: number }): void => {
		const st = store.readState();
		st.breakers[key] = b;
		store.writeState(st);
	};

	return {
		isOpen(): boolean {
			if (!env.isCI) return false;
			const b = read();
			if (!b.openUntil) return false;
			return env.now.getTime() < new Date(b.openUntil).getTime();
		},
		recordFailure(): void {
			const b = read();
			const failures = b.failures + 1;
			let openUntil = b.openUntil;
			if (env.isCI && failures >= consecutive_failures) {
				openUntil = new Date(
					env.now.getTime() + cooldown_hours * 3_600_000,
				).toISOString();
			}
			write({ failures, openUntil });
		},
		recordSuccess(): void {
			write({ failures: 0 });
		},
	};
}

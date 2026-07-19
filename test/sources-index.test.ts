import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { makeCiBreaker } from "../src/sources/fli";
import { buildSources } from "../src/sources/index";
import { makeDryRunStore, Store } from "../src/state/store";
import type { FareObservation } from "../src/types";

const cfg = loadConfig({ env: {} });
const now = new Date("2026-07-18T10:00:00Z");
const envCI = { isCI: true, hasBrowser: false, now };

const obs = (over: Partial<FareObservation>): FareObservation => ({
	id: "x",
	source: "travelpayouts",
	origin: "TYO",
	destination: "BKK",
	departDate: "2026-08-02",
	transfers: 0,
	priceJpy: 14000,
	market: "jp",
	foundAt: now.toISOString(),
	...over,
});

describe("makeDryRunStore (C1)", () => {
	test("書き込み系は全てno-op(ディスクに何も残らない)", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const dry = makeDryRunStore(store);

		dry.writeState({
			lastRuns: { "window:near": now.toISOString() },
			rssSeen: {},
			breakers: { fli: { failures: 3 } },
			verifyQueue: ["x"],
		});
		dry.writeQuota({ month: "2026-07", used: 10 });
		dry.writeDeals([]);
		dry.writeHealth({ fli: { consecutiveFailures: 6 } });
		dry.appendFares([obs({ id: "a" })]);
		dry.appendNotified({
			dealKey: "k",
			priceJpy: 1,
			at: now.toISOString(),
			tier: "deal",
		});

		expect(existsSync(join(dir, "state.json"))).toBe(false);
		expect(existsSync(join(dir, "quota.json"))).toBe(false);
		expect(existsSync(join(dir, "deals.json"))).toBe(false);
		expect(existsSync(join(dir, "health.json"))).toBe(false);
		expect(existsSync(join(dir, "notified.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "fares"))).toBe(false);
	});

	test("読み取り系は実storeへ委譲する", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		store.writeState({
			lastRuns: { "window:near": "2026-07-18T00:00:00Z" },
			rssSeen: {},
			breakers: {},
			verifyQueue: ["it-1"],
		});
		store.writeQuota({ month: "2026-07", used: 3 });
		store.writeDeals([]);
		store.writeHealth({ fli: { consecutiveFailures: 2 } });
		store.appendFares([obs({ id: "a" })]);

		const dry = makeDryRunStore(store);
		expect(dry.readState().lastRuns["window:near"]).toBe(
			"2026-07-18T00:00:00Z",
		);
		expect(dry.readState().verifyQueue).toEqual(["it-1"]);
		expect(dry.readQuota().used).toBe(3);
		expect(dry.readDeals()).toEqual([]);
		expect(dry.readHealth().fli?.consecutiveFailures).toBe(2);
		expect(dry.readNotified()).toEqual({});
		expect(dry.readRecentFares(48, now).map((o) => o.id)).toEqual(["a"]);
	});
});

describe("makeCiBreaker on a dryRun store (C1)", () => {
	test("recordFailureを繰り返してもdryRunストア配下ではstate.jsonが作られない", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const breaker = makeCiBreaker(makeDryRunStore(store), cfg, envCI);

		breaker.recordFailure();
		breaker.recordFailure();
		breaker.recordFailure();

		// isOpen()の真偽はメモリ内実装依存でどちらでもよい(ここでは検証しない)。
		// 重要なのはdryRun run経由で実ディスクに一切書き込みが発生していないこと —
		// これが無ければ、dryRunのwatchを繰り返すだけで本物のCIサーキットブレーカが
		// 6時間openしてしまう(C1)。
		expect(existsSync(join(dir, "state.json"))).toBe(false);
	});
});

describe("buildSources", () => {
	// Task 15b: skyscanner(Playwright, best-effort)が追加され、opts省略時/dryRun時ともに
	// 5ソースを返す(Task 15でgf-browser追加時の3→4と同じ形の変更)。available(env)による
	// 絞り込みはbuildSources自身の責務ではなく呼び出し側(pipeline/cli)が行うため、
	// isCI=trueのenvCI下でもgf-browser/skyscannerは(available=falseになるだけで)配列には
	// 含まれる。
	test("opts省略時は5ソース(fli/gf-browser/serpapi/skyscanner/travelpayouts)を返す", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const sources = buildSources(cfg, store, envCI);
		expect(sources.map((s) => s.name).sort()).toEqual(
			["fli", "gf-browser", "serpapi", "skyscanner", "travelpayouts"].sort(),
		);
	});

	test("dryRun:trueでも同じ5ソースを返す(内部storeがdryRunラップされるだけ)", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const sources = buildSources(cfg, store, envCI, { dryRun: true });
		expect(sources.map((s) => s.name).sort()).toEqual(
			["fli", "gf-browser", "serpapi", "skyscanner", "travelpayouts"].sort(),
		);
	});

	test("gf-browserはisCI=trueのenvCI下ではavailable=false(配列には含まれる)", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const sources = buildSources(cfg, store, envCI);
		const gfBrowser = sources.find((s) => s.name === "gf-browser");
		expect(gfBrowser).toBeDefined();
		expect(gfBrowser?.available(envCI)).toBe(false);
	});

	test("skyscannerはisCI=trueのenvCI下ではavailable=false(配列には含まれる)", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const sources = buildSources(cfg, store, envCI);
		const skyscanner = sources.find((s) => s.name === "skyscanner");
		expect(skyscanner).toBeDefined();
		expect(skyscanner?.available(envCI)).toBe(false);
	});
});

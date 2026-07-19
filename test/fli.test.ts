import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { FliSource, makeCiBreaker } from "../src/sources/fli";
import { Store } from "../src/state/store";

const cfg = loadConfig({ env: {} });
const fixture = await Bun.file("test/fixtures/fli-search.json").text();
const datesFixture = await Bun.file("test/fixtures/fli-dates.json").text();

// Step 1で確定したCLI契約（punitarani/fli, pip名=flights, CLI=fli）。
// uvxの実体: uvx --from flights --with click fli <これらの引数>
const FLI_ARGS = [
	"flights",
	"NRT",
	"BKK",
	"2026-08-02",
	"--currency",
	"JPY",
	"--country",
	"JP",
	"--stops",
	"ANY",
	"--sort",
	"CHEAPEST",
	"--format",
	"json",
];
const DATES_ARGS = [
	"dates",
	"NRT",
	"BKK",
	"--from",
	"2026-08-01",
	"--to",
	"2026-08-07",
	"--currency",
	"JPY",
	"--country",
	"JP",
	"--sort",
	"--format",
	"json",
];

const jp = { origin: "NRT", destination: "BKK", market: "jp" };
const okRun = async () => ({ exitCode: 0, stdout: fixture, stderr: "" });
const datesRun = async () => ({
	exitCode: 0,
	stdout: datesFixture,
	stderr: "",
});
const failRun = async () => ({ exitCode: 1, stdout: "", stderr: "blocked" });
const mkBreaker = () => {
	let failures = 0;
	let open = false;
	return {
		isOpen: () => open,
		recordFailure: () => {
			if (++failures >= 3) open = true;
		},
		recordSuccess: () => {
			failures = 0;
		},
	};
};
const tmpStore = () => new Store(mkdtempSync(join(tmpdir(), "tfw-fli-")));

// console.warnをスパイして実際に出力される全引数を捕捉する(travelpayouts.test.tsと同じ手法)。
// 非文字列引数はBun.inspectで展開してから連結し、生Errorオブジェクトを渡した場合に
// enumerableプロパティが漏れることを検出できるようにする。
function captureWarn(): { text: () => string; restore: () => void } {
	const calls: unknown[][] = [];
	const original = console.warn;
	console.warn = ((...args: unknown[]) => {
		calls.push(args);
	}) as typeof console.warn;
	return {
		text: () =>
			calls
				.map((args) =>
					args
						.map((a) => (typeof a === "string" ? a : Bun.inspect(a)))
						.join(" "),
				)
				.join("\n"),
		restore: () => {
			console.warn = original;
		},
	};
}

describe("FliSource.verify", () => {
	test("確定したFLI_ARGSでrunを呼ぶ（片道/JPY/JP-POS/JSON）", async () => {
		let captured: string[] = [];
		const spy = async (args: string[]) => {
			captured = args;
			return { exitCode: 0, stdout: fixture, stderr: "" };
		};
		const s = new FliSource(cfg, { run: spy, breaker: mkBreaker() });
		await s.verify(jp, "2026-08-02");
		expect(captured).toEqual(FLI_ARGS);
	});

	test("VerifiedOffer(sellers=[], source=fli, JPY価格)を返す", async () => {
		const now = new Date("2026-07-19T00:00:00Z");
		const s = new FliSource(cfg, { run: okRun, breaker: mkBreaker(), now });
		const got = await s.verify(jp, "2026-08-02");
		expect(got.length).toBeGreaterThan(0);
		const o = got[0];
		if (!o) throw new Error("expected at least one offer");
		expect(o.sellers).toEqual([]);
		expect(o.source).toBe("fli");
		expect(o.priceJpy).toBe(36072); // 36072.0 -> 整数
		expect(o.priceJpy).toBeGreaterThan(0);
		expect(o.market).toBe("jp");
		expect(o.origin).toBe("NRT");
		expect(o.destination).toBe("BKK");
		expect(o.airline).toBe("ZG");
		expect(o.flightNumber).toBe("ZG51");
		expect(o.transfers).toBe(0);
		expect(o.departAt).toBe("2026-08-18T17:00:00");
		expect(o.arriveAt).toBe("2026-08-18T21:40:00");
		expect(o.foundAt).toBe(now.toISOString());
		expect(o.expiresAt).toBeUndefined(); // ライブ検索は失効時刻なし
		expect(o.id).toMatch(/^[0-9a-f]{12}$/);
	});

	test("複数レグ便は乗継数と結合便名を持つ", async () => {
		const s = new FliSource(cfg, { run: okRun, breaker: mkBreaker() });
		const got = await s.verify(jp, "2026-08-02");
		const multi = got.find((o) => o.transfers > 0);
		if (!multi) throw new Error("expected a multi-leg offer");
		expect(multi.transfers).toBe(1);
		expect(multi.flightNumber).toBe("7C1110+7C2503");
		expect(multi.origin).toBe("NRT");
		expect(multi.destination).toBe("BKK");
		expect(multi.priceJpy).toBe(37660);
	});

	test("price:null等の不完全行はスキップし良行のみ返す", async () => {
		const s = new FliSource(cfg, { run: okRun, breaker: mkBreaker() });
		const got = await s.verify(jp, "2026-08-02");
		// fixtureは3便(ZG/7C/VN)、VN便はprice:null → 良行2件のみ返る
		expect(got.length).toBe(2);
		expect(got.every((o) => o.priceJpy > 0)).toBe(true);
		expect(got.some((o) => o.airline === "VN")).toBe(false);
	});

	test("non-JPY行は個別スキップし良行のみ返す（1件混入・全滅ではない）", async () => {
		const mixed = JSON.stringify({
			success: true,
			flights: [
				{
					stops: 0,
					price: 36072.0,
					currency: "JPY",
					legs: [
						{
							departure_airport: { code: "NRT" },
							arrival_airport: { code: "BKK" },
							departure_time: "2026-08-18T17:00:00",
							arrival_time: "2026-08-18T21:40:00",
							airline: { code: "ZG" },
							flight_number: "51",
						},
					],
				},
				{
					// non-JPY混入行。全滅ではないのでスキップのみ、他の良行はthrowで捨てない。
					stops: 0,
					price: 250.0,
					currency: "USD",
					legs: [
						{
							departure_airport: { code: "NRT" },
							arrival_airport: { code: "BKK" },
							departure_time: "2026-08-18T10:00:00",
							arrival_time: "2026-08-18T14:00:00",
							airline: { code: "AA" },
							flight_number: "1",
						},
					],
				},
				{
					stops: 0,
					price: 40000.0,
					currency: "JPY",
					legs: [
						{
							departure_airport: { code: "NRT" },
							arrival_airport: { code: "BKK" },
							departure_time: "2026-08-18T09:00:00",
							arrival_time: "2026-08-18T13:00:00",
							airline: { code: "TG" },
							flight_number: "621",
						},
					],
				},
			],
		});
		const s = new FliSource(cfg, {
			run: async () => ({ exitCode: 0, stdout: mixed, stderr: "" }),
			breaker: mkBreaker(),
		});
		const got = await s.verify(jp, "2026-08-18");
		expect(got.length).toBe(2); // USD行のみ除外、JPY2件は活きる
		expect(got.map((o) => o.airline)).toEqual(["ZG", "TG"]);
		expect(got.every((o) => o.priceJpy > 0)).toBe(true);
	});

	test("non-JPYが1件のみ（全滅）→ 通貨名を含めてthrow", async () => {
		const usd = JSON.stringify({
			success: true,
			flights: [
				{
					stops: 0,
					price: 250.0,
					currency: "USD",
					legs: [
						{
							departure_airport: { code: "NRT" },
							arrival_airport: { code: "BKK" },
							departure_time: "2026-08-02T10:00:00",
							arrival_time: "2026-08-02T14:00:00",
							airline: { code: "ZG" },
							flight_number: "51",
						},
					],
				},
			],
		});
		const breaker = mkBreaker();
		const s = new FliSource(cfg, {
			run: async () => ({ exitCode: 0, stdout: usd, stderr: "" }),
			breaker,
		});
		await expect(s.verify(jp, "2026-08-02")).rejects.toThrow(/USD/);
		expect(breaker.isOpen()).toBe(false); // 1回のみ、まだ開かない（閾値3未満）
	});

	test("3連続失敗でブレーカが開きavailable=false", async () => {
		const breaker = mkBreaker();
		const s = new FliSource(cfg, { run: failRun, breaker });
		const env = { isCI: true, hasBrowser: false, now: new Date() };
		for (let i = 0; i < 3; i++) {
			await s.verify(jp, "2026-08-02").catch(() => {});
		}
		expect(s.available(env)).toBe(false);
	});
});

describe("FliSource.sweep", () => {
	test("ネイティブ`fli dates`をDATES_ARGSで呼び最安日をFareObservation化", async () => {
		let captured: string[] = [];
		const spy = async (args: string[]) => {
			captured = args;
			return { exitCode: 0, stdout: datesFixture, stderr: "" };
		};
		const s = new FliSource(cfg, { run: spy, breaker: mkBreaker() });
		const got = await s.sweep([jp], { from: "2026-08-01", to: "2026-08-07" });
		expect(captured).toEqual(DATES_ARGS);
		// fixtureは4件(price:null 1件を含む)だが、有効な3件のみ返る。
		expect(got.length).toBe(3);
		expect(got.some((o) => o.departDate === "2026-08-18")).toBe(false); // null価格行はスキップ
		const o = got[0];
		if (!o) throw new Error("expected observations");
		expect(o.source).toBe("fli");
		expect(o.departDate).toBe("2026-08-15");
		expect(o.priceJpy).toBe(31742);
		expect(o.market).toBe("jp");
		expect(o.id).toMatch(/^[0-9a-f]{12}$/);
	});

	test("全ペア失敗でthrow", async () => {
		const s = new FliSource(cfg, { run: failRun, breaker: mkBreaker() });
		expect(
			s.sweep([jp], { from: "2026-08-01", to: "2026-08-07" }),
		).rejects.toThrow();
	});

	test("全行が非JPY（dates）→ 通貨名を含めてthrow＋breaker.recordFailureが発火", async () => {
		const allUsd = JSON.stringify({
			success: true,
			dates: [
				{
					departure_date: "2026-08-15",
					return_date: null,
					price: 250.0,
					currency: "USD",
				},
				{
					departure_date: "2026-08-16",
					return_date: null,
					price: 260.0,
					currency: "USD",
				},
			],
		});
		let failureCalls = 0;
		const breaker = {
			isOpen: () => false,
			recordFailure: () => {
				failureCalls++;
			},
			recordSuccess: () => {},
		};
		const s = new FliSource(cfg, {
			run: async () => ({ exitCode: 0, stdout: allUsd, stderr: "" }),
			breaker,
		});
		await expect(
			s.sweep([jp], { from: "2026-08-01", to: "2026-08-07" }),
		).rejects.toThrow(/USD/);
		expect(failureCalls).toBe(1);
	});

	test("datesRunでも動く（別ヘルパ経由）", async () => {
		const s = new FliSource(cfg, { run: datesRun, breaker: mkBreaker() });
		const got = await s.sweep([jp], { from: "2026-08-01", to: "2026-08-07" });
		expect(got.map((o) => o.priceJpy)).toEqual([31742, 33675, 36575]);
	});

	// --- セキュリティ修正(Task 14 fix report 2): 生Errorオブジェクトのログ経由の秘密漏洩 ---
	test("run()がenumerableな秘密プロパティを持つErrorをthrowしてもconsole.warnの出力に秘密が出ない", async () => {
		const run = async () => {
			const e = new Error("spawn failed");
			(e as unknown as { path: string }).path =
				"uvx://fli?token=FLISWEEPSECRET1";
			throw e;
		};
		const s = new FliSource(cfg, { run, breaker: mkBreaker() });
		const warn = captureWarn();
		try {
			// 全滅時の集約throwはこのテストの関心外(console.warn出力のみ検証する)。
			await s
				.sweep([jp], { from: "2026-08-01", to: "2026-08-07" })
				.catch(() => {});
		} finally {
			warn.restore();
		}
		expect(warn.text()).not.toContain("FLISWEEPSECRET1");
	});
});

describe("FliSource.available", () => {
	test("enabled=falseならavailable=false", () => {
		const disabled = loadConfig({ env: {} });
		disabled.fli.enabled = false;
		const s = new FliSource(disabled, { run: okRun, breaker: mkBreaker() });
		const env = { isCI: false, hasBrowser: false, now: new Date() };
		expect(s.available(env)).toBe(false);
	});
	test("enabled かつ breaker閉ならavailable=true", () => {
		const s = new FliSource(cfg, { run: okRun, breaker: mkBreaker() });
		const env = { isCI: false, hasBrowser: false, now: new Date() };
		expect(s.available(env)).toBe(true);
	});
});

describe("makeCiBreaker", () => {
	test("CI: 3連続失敗でopen、successでreset（stateに永続化）", () => {
		const store = tmpStore();
		const now = new Date("2026-07-19T00:00:00Z");
		const env = { isCI: true, hasBrowser: false, now };
		const b = makeCiBreaker(store, cfg, env);
		expect(b.isOpen()).toBe(false);
		b.recordFailure();
		b.recordFailure();
		expect(b.isOpen()).toBe(false); // 2回、閾値未満
		b.recordFailure();
		expect(b.isOpen()).toBe(true);
		expect(store.readState().breakers.fli?.openUntil).toBeDefined();
		b.recordSuccess();
		expect(b.isOpen()).toBe(false);
		expect(store.readState().breakers.fli?.failures).toBe(0);
		expect(store.readState().breakers.fli?.openUntil).toBeUndefined();
	});

	test("非CI: 失敗を数えてもopenしない", () => {
		const store = tmpStore();
		const env = { isCI: false, hasBrowser: false, now: new Date() };
		const b = makeCiBreaker(store, cfg, env);
		for (let i = 0; i < 5; i++) b.recordFailure();
		expect(b.isOpen()).toBe(false);
		expect(store.readState().breakers.fli?.failures).toBe(5); // 追跡はされる
	});

	test("cooldown満了後はisOpen=false（永続stateを別インスタンスが読む）", () => {
		const store = tmpStore();
		const t0 = new Date("2026-07-19T00:00:00Z");
		const b0 = makeCiBreaker(store, cfg, {
			isCI: true,
			hasBrowser: false,
			now: t0,
		});
		b0.recordFailure();
		b0.recordFailure();
		b0.recordFailure();
		expect(b0.isOpen()).toBe(true);
		const t1 = new Date("2026-07-19T07:00:00Z"); // 6h cooldown 経過
		const b1 = makeCiBreaker(store, cfg, {
			isCI: true,
			hasBrowser: false,
			now: t1,
		});
		expect(b1.isOpen()).toBe(false);
	});
});

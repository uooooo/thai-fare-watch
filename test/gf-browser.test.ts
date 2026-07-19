import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import type { Browser, Page } from "../src/sources/gf-browser/index";
import { GfBrowserSource, rateLimitMs } from "../src/sources/gf-browser/index";
import type { OdPair } from "../src/types";
import realResultRowLabels from "./fixtures/gf/result-rows.json";

const cfg = loadConfig({ env: {} });
const now = new Date("2026-07-19T00:00:00Z");
const nrtBkk: OdPair = { origin: "NRT", destination: "BKK", market: "jp" };

// 実キャプチャで確認済みの結果行aria-label形状(test/fixtures/gf/result-rows.jsonの一部)を
// そのままモックPageの戻り値に使う(parse.tsのテストと同じ実データに基づく)。
const ZIP_LABEL =
	"36072 円～。 ZIPAIR Tokyo が運航する直行便。 火曜日, 8月 18 17:00 成田国際空港発、火曜日, 8月 18 21:40 スワンナプーム国際空港着。 合計時間 6時間 40分。   フライトを選択";
const THAI_VJ_LABEL =
	"36575 円～。 タイ・ベトジェット・エア が運航する直行便。 火曜日, 8月 18 8:55 成田国際空港発、火曜日, 8月 18 13:45 スワンナプーム国際空港着。 合計時間 6時間 50分。   フライトを選択";
const ZIP_BOOKING_LABEL =
	"航空会社 ZIPAIR Tokyo での予約手続きに進む（料金: 36072 円）";
// 実fixture(test/fixtures/gf/result-rows.json)中の、同一料金(¥46,300)だが出発時刻が
// 異なる3本のTHAI直行便(同route/date)。flightNumberは常にundefinedなので、idに
// departAt/arriveAtを含めない旧実装では3本とも同一idに潰れてしまう(dedup誤爆)。
const THAI_1050_LABEL =
	"46300 円～。 THAI が運航する直行便。 火曜日, 8月 18 10:50 成田国際空港発、火曜日, 8月 18 15:20 スワンナプーム国際空港着。 合計時間 6時間 30分。   フライトを選択";
const THAI_1200_LABEL =
	"46300 円～。 THAI が運航する直行便。 火曜日, 8月 18 12:00 成田国際空港発、火曜日, 8月 18 16:30 スワンナプーム国際空港着。 合計時間 6時間 30分。   フライトを選択";
const THAI_1725_LABEL =
	"46300 円～。 THAI が運航する直行便。 火曜日, 8月 18 17:25 成田国際空港発、火曜日, 8月 18 21:55 スワンナプーム国際空港着。 合計時間 6時間 30分。   フライトを選択";
const GRID_LABELS = [
	"8月1日 土曜日、32000円",
	"8月2日 日曜日、31500円",
	"8月3日 月曜日、価格情報なし",
];

type PageCalls = {
	newPageCalls: number;
	closeCalls: number;
	openDateGridCalls: number;
	clickedAriaLabels: string[];
	collectFilters: Array<"grid" | "result" | "booking">;
};

function fakePage(
	calls: PageCalls,
	opts: {
		gridLabels?: string[];
		resultLabels?: string[];
		bookingLabels?: string[];
		onCollectBooking?: () => string[];
		throwOnCollect?: "grid" | "result";
	} = {},
): Page {
	return {
		async gotoFlights() {},
		async dismissConsent() {},
		async openDateGrid() {
			calls.openDateGridCalls++;
		},
		async collectAriaLabels(filter) {
			calls.collectFilters.push(filter);
			if (filter === opts.throwOnCollect) {
				throw new Error(`gf-browser: ${filter}: simulated failure`);
			}
			if (filter === "grid") return opts.gridLabels ?? [];
			if (filter === "result") return opts.resultLabels ?? [];
			return opts.onCollectBooking?.() ?? opts.bookingLabels ?? [];
		},
		async clickResultRow(ariaLabel) {
			calls.clickedAriaLabels.push(ariaLabel);
		},
		async close() {
			calls.closeCalls++;
		},
	};
}

function fakeLaunch(
	pages: Page[],
	calls: PageCalls,
): { launch: () => Promise<Browser>; browserCloseCalls: () => number } {
	let idx = 0;
	let browserCloseCalls = 0;
	const browser: Browser = {
		async newPage() {
			calls.newPageCalls++;
			const p = pages[idx++];
			if (!p) throw new Error("test double: no more fake pages configured");
			return p;
		},
		async close() {
			browserCloseCalls++;
		},
	};
	return {
		launch: async () => browser,
		browserCloseCalls: () => browserCloseCalls,
	};
}

function newCalls(): PageCalls {
	return {
		newPageCalls: 0,
		closeCalls: 0,
		openDateGridCalls: 0,
		clickedAriaLabels: [],
		collectFilters: [],
	};
}

describe("GfBrowserSource.available", () => {
	test("!isCI && hasBrowser && enabled!==false → true", () => {
		const src = new GfBrowserSource(cfg);
		expect(src.available({ isCI: false, hasBrowser: true, now })).toBe(true);
	});
	test("isCI=true → false", () => {
		const src = new GfBrowserSource(cfg);
		expect(src.available({ isCI: true, hasBrowser: true, now })).toBe(false);
	});
	test("hasBrowser=false → false", () => {
		const src = new GfBrowserSource(cfg);
		expect(src.available({ isCI: false, hasBrowser: false, now })).toBe(false);
	});
	test("cfg.browser.enabled=false → false", () => {
		const disabled = loadConfig({ env: {} });
		disabled.browser.enabled = false;
		const src = new GfBrowserSource(disabled);
		expect(src.available({ isCI: false, hasBrowser: true, now })).toBe(false);
	});
});

describe("rateLimitMs", () => {
	test("rand=0 → min_interval_secちょうど(ミリ秒換算)", () => {
		expect(rateLimitMs(cfg, () => 0)).toBe(cfg.browser.min_interval_sec * 1000);
	});
	test("rand=0.5 → min_interval_sec + jitter_sec*0.5(ミリ秒換算)", () => {
		const expected =
			(cfg.browser.min_interval_sec + cfg.browser.jitter_sec * 0.5) * 1000;
		expect(rateLimitMs(cfg, () => 0.5)).toBe(expected);
	});
	test("randを渡さなければMath.random由来で[min, min+jitter)ミリ秒の範囲に収まる", () => {
		const ms = rateLimitMs(cfg);
		expect(ms).toBeGreaterThanOrEqual(cfg.browser.min_interval_sec * 1000);
		expect(ms).toBeLessThan(
			(cfg.browser.min_interval_sec + cfg.browser.jitter_sec) * 1000,
		);
	});
});

describe("GfBrowserSource.sweep", () => {
	test("グリッドセルをFareObservation化する(source/market/transfers/foundAt/expiresAt)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { gridLabels: GRID_LABELS });
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });

		const got = await src.sweep([nrtBkk], {
			from: "2026-08-01",
			to: "2026-08-31",
		});

		expect(got.length).toBe(2); // 価格情報なしの1件は除外
		const o = got[0];
		if (!o) throw new Error("expected an observation");
		expect(o.source).toBe("gf-browser");
		expect(o.origin).toBe("NRT");
		expect(o.destination).toBe("BKK");
		expect(o.market).toBe("jp");
		expect(o.transfers).toBe(0);
		expect(o.departDate).toBe("2026-08-01");
		expect(o.priceJpy).toBe(32000);
		expect(o.foundAt).toBe(now.toISOString());
		expect(o.expiresAt).toBe(
			new Date(now.getTime() + 6 * 3_600_000).toISOString(),
		);
		expect(o.id).toMatch(/^[0-9a-f]{12}$/);
	});

	test("range外の日付は除外する", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			gridLabels: ["8月1日 土曜日、32000円", "9月1日 火曜日、40000円"],
		});
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });

		const got = await src.sweep([nrtBkk], {
			from: "2026-08-01",
			to: "2026-08-31",
		});
		expect(got.map((o) => o.departDate)).toEqual(["2026-08-01"]);
	});

	test("複数ペアはdeps.sleepでmin_interval_sec〜+jitter_sec秒だけ待ち、ペア間(N-1回)のみ呼ぶ(注入したsleepで検証、グローバルBun.sleepは書き換えない)", async () => {
		const calls = newCalls();
		const pageA = fakePage(calls, { gridLabels: GRID_LABELS });
		const pageB = fakePage(calls, { gridLabels: GRID_LABELS });
		const pageC = fakePage(calls, { gridLabels: GRID_LABELS });
		const { launch } = fakeLaunch([pageA, pageB, pageC], calls);
		const tinyCfg = {
			...cfg,
			browser: { ...cfg.browser, min_interval_sec: 0.01, jitter_sec: 0.01 },
		};
		const sleptMs: number[] = [];
		const sleep = (ms: number) => {
			sleptMs.push(ms);
			return Promise.resolve();
		};
		const src = new GfBrowserSource(tinyCfg, { launch, now, sleep });

		const pairB2: OdPair = {
			origin: "OSA",
			destination: "BKK",
			market: "jp",
		};
		const pairC2: OdPair = {
			origin: "FUK",
			destination: "BKK",
			market: "jp",
		};
		await src.sweep([nrtBkk, pairB2, pairC2], {
			from: "2026-08-01",
			to: "2026-08-31",
		});

		expect(sleptMs.length).toBe(2); // 3ペア→ペア間は2回のみ、最後のペアの後には呼ばない
		for (const ms of sleptMs) {
			expect(ms).toBeGreaterThanOrEqual(10);
			expect(ms).toBeLessThan(30);
		}
	});

	test("グリッドが0件(CAPTCHA/ブロック相当)ならthrowする", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { gridLabels: [] });
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });
		await expect(
			src.sweep([nrtBkk], { from: "2026-08-01", to: "2026-08-31" }),
		).rejects.toThrow();
	});

	test("browser.close()は正常時・例外時のいずれもfinallyで呼ばれる", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { throwOnCollect: "grid" });
		const { launch, browserCloseCalls } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });
		await src
			.sweep([nrtBkk], { from: "2026-08-01", to: "2026-08-31" })
			.catch(() => {});
		expect(browserCloseCalls()).toBe(1);
		expect(calls.closeCalls).toBe(1);
	});
});

describe("GfBrowserSource.verify", () => {
	test("結果行をVerifiedOffer化し、最安行のみ販売元(sellers)を持つ", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			resultLabels: [ZIP_LABEL, THAI_VJ_LABEL],
			bookingLabels: [ZIP_BOOKING_LABEL],
		});
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });

		const got = await src.verify(nrtBkk, "2026-08-18");

		expect(got.length).toBe(2);
		const zip = got.find((o) => o.airline === "ZIPAIR Tokyo");
		const thaiVj = got.find((o) => o.airline === "タイ・ベトジェット・エア");
		if (!zip || !thaiVj) throw new Error("expected both offers");
		expect(zip.source).toBe("gf-browser");
		expect(zip.market).toBe("jp");
		expect(zip.foundAt).toBe(now.toISOString());
		// ZIPAIRが最安(36072 < 36575)なので予約オプションはZIPAIR側にのみ付く
		expect(zip.sellers).toEqual([
			{
				seller: "ZIPAIR Tokyo",
				isAirlineDirect: false,
				trust: "reference",
				priceJpy: 36072,
			},
		]);
		expect(thaiVj.sellers).toEqual([]);
		// クリック対象は最安行の元aria-labelそのもの
		expect(calls.clickedAriaLabels).toEqual([ZIP_LABEL]);
	});

	test("結果行が0件(CAPTCHA/ブロック相当)ならthrowする", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { resultLabels: [] });
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });
		await expect(src.verify(nrtBkk, "2026-08-18")).rejects.toThrow();
	});

	test("予約オプション取得が失敗してもベストエフォートで価格オファーは返す(sellersは空)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			resultLabels: [ZIP_LABEL],
			onCollectBooking: () => {
				throw new Error("booking panel not found");
			},
		});
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });

		const got = await src.verify(nrtBkk, "2026-08-18");
		expect(got.length).toBe(1);
		expect(got[0]?.sellers).toEqual([]);
	});

	// 重複除去は現在、パース前の生aria-label文字列を完全一致(Set)でdedupする段で行われる
	// (Google実DOMが結果行をbyte-identicalに二重表示するため)。ZIP_LABELの2件はここで
	// 1件に潰れ、THAI_VJ_LABELの1件と合わせて期待値は2件——これはstableId経由の後段dedup
	// のみだった旧実装でも同じ値になる(内容が完全一致する重複はどちらの実装でも2件に
	// 収束するため、このテスト単体では新旧の実装差を検出できない)。新旧の実装差
	// (=同一料金だが別便のflightを誤って1件に潰さないか)を検出するのは、この直後の
	// 「同一料金・別時刻」テストと実fixtureテスト。
	test("重複するaria-label(同一内容)は生ラベルの完全一致dedupで除去される(パース前)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			resultLabels: [ZIP_LABEL, ZIP_LABEL, THAI_VJ_LABEL],
			bookingLabels: [ZIP_BOOKING_LABEL],
		});
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });
		const got = await src.verify(nrtBkk, "2026-08-18");
		expect(got.length).toBe(2);
	});

	// Critical fix regression: parsed.flightNumberはgf-browserでは常にundefinedなので、
	// 旧実装のid(flightNumber+priceJpyのみで識別)では同一route/date/価格の別便が
	// 衝突して脱落していた。departAt/arriveAtをidに含めることで、時刻が異なれば
	// 別idとして区別できる。
	test("同一料金・別時刻の便は別idとして全件残る(THAI 3便、いずれも¥46,300)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			resultLabels: [THAI_1050_LABEL, THAI_1200_LABEL, THAI_1725_LABEL],
		});
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });

		const got = await src.verify(nrtBkk, "2026-08-18");

		expect(got.length).toBe(3);
		expect(new Set(got.map((o) => o.id)).size).toBe(3);
		expect(got.map((o) => o.departAt).sort()).toEqual([
			"2026-08-18T10:50:00",
			"2026-08-18T12:00:00",
			"2026-08-18T17:25:00",
		]);
	});

	// Critical fix regression(実fixture): test/fixtures/gf/result-rows.jsonは実キャプチャ
	// 18行=9便が2重表示されたもの。旧実装ではGoogleの2重表示は正しく1件に畳めるが、
	// 9便中3便(THAI 10:50/12:00/17:25、いずれも¥46,300)が同一idに衝突し、9件→7件に
	// 脱落していた(THAI 12:00と17:25が消える)。修正後は9件全てが別idで残る。
	test("実fixture(18行=9便×2重複)は9件の別便すべてが残る(同一料金の別便を誤って1件に潰さない)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			resultLabels: realResultRowLabels as string[],
		});
		const { launch } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });

		const got = await src.verify(nrtBkk, "2026-08-18");

		expect(got.length).toBe(9);
		expect(new Set(got.map((o) => o.id)).size).toBe(9);
	});

	test("browser.close()は正常時・例外時のいずれもfinallyで呼ばれる", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { throwOnCollect: "result" });
		const { launch, browserCloseCalls } = fakeLaunch([page], calls);
		const src = new GfBrowserSource(cfg, { launch, now });
		await src.verify(nrtBkk, "2026-08-18").catch(() => {});
		expect(browserCloseCalls()).toBe(1);
		expect(calls.closeCalls).toBe(1);
	});
});

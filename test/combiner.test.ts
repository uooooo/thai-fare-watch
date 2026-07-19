import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { combine } from "../src/core/combiner";
import type { FareObservation } from "../src/types";

const cfg = loadConfig({ env: {} });
const ob = (o: Partial<FareObservation>): FareObservation => ({
	id: Math.random().toString(16).slice(2, 14),
	source: "travelpayouts",
	origin: "TYO",
	destination: "BKK",
	departDate: "2026-08-02",
	transfers: 0,
	priceJpy: 20000,
	market: "jp",
	foundAt: "2026-07-18T00:00:00+09:00",
	...o,
});

describe("combine", () => {
	test("直行はdirect、乗継ありはthrough", () => {
		const its = combine(
			[ob({ priceJpy: 14000 }), ob({ transfers: 1, priceJpy: 12000 })],
			cfg,
		);
		expect(its.map((i) => i.kind).sort()).toEqual(["direct", "through"]);
	});
	test("別切り: 時刻既知で接続4h未満は除外、4h以上は採用", () => {
		const leg1ok = ob({
			origin: "TYO",
			destination: "SEL",
			departAt: "2026-08-02T08:00",
			arriveAt: "2026-08-02T10:30",
			priceJpy: 5000,
		});
		const leg2 = ob({
			origin: "SEL",
			destination: "BKK",
			departAt: "2026-08-02T15:00",
			arriveAt: "2026-08-02T19:00",
			priceJpy: 6000,
			market: "kr",
		});
		const leg1late = ob({
			origin: "TYO",
			destination: "SEL",
			departAt: "2026-08-02T11:30",
			arriveAt: "2026-08-02T13:30",
			priceJpy: 4000,
		});
		const its = combine([leg1ok, leg2, leg1late], cfg).filter(
			(i) => i.kind === "self_transfer",
		);
		expect(its).toHaveLength(1);
		expect(its[0]?.risks).toContain("自己乗継(別切り)");
	});
	test("別切りの海外市場レグにはfx手数料が乗る", () => {
		const leg1 = ob({
			origin: "TYO",
			destination: "SEL",
			departAt: "2026-08-02T08:00",
			arriveAt: "2026-08-02T10:30",
			priceJpy: 5000,
		});
		const leg2 = ob({
			origin: "SEL",
			destination: "BKK",
			departAt: "2026-08-02T16:00",
			arriveAt: "2026-08-02T20:00",
			priceJpy: 10000,
			market: "kr",
		});
		const it = combine([leg1, leg2], cfg).find(
			(i) => i.kind === "self_transfer",
		);
		if (!it) throw new Error("self_transfer not found");
		expect(it.totalJpy).toBe(5000 + Math.round(10000 * 1.022));
		expect(it.fxFeeJpy).toBe(220);
	});
	test("時刻不明の同日別切りは「時刻要確認」、翌日はallow_next_dayで成立", () => {
		const leg1 = ob({ origin: "TYO", destination: "TPE", priceJpy: 4000 });
		const leg2same = ob({
			origin: "TPE",
			destination: "BKK",
			priceJpy: 5000,
			market: "tw",
		});
		const leg2next = ob({
			origin: "TPE",
			destination: "BKK",
			departDate: "2026-08-03",
			priceJpy: 4500,
			market: "tw",
		});
		const its = combine([leg1, leg2same, leg2next], cfg).filter(
			(i) => i.kind === "self_transfer",
		);
		expect(its).toHaveLength(2);
		const sameDay = its.find(
			(i) => (i.legs[1] as FareObservation).departDate === "2026-08-02",
		);
		const nextDay = its.find(
			(i) => (i.legs[1] as FareObservation).departDate === "2026-08-03",
		);
		expect(sameDay?.risks).toContain("時刻要確認");
		expect(nextDay?.risks).toContain("翌日乗継(宿泊の可能性)");
	});
	test("国内ポジショニング: OSA発国際線にground前置でpositioned", () => {
		const intl = ob({
			origin: "OSA",
			destination: "BKK",
			departAt: "2026-08-02T14:00",
			priceJpy: 8000,
		});
		const its = combine([intl], cfg).filter((i) => i.kind === "positioned");
		expect(its).toHaveLength(1);
		expect(its[0]?.totalJpy).toBe(8000 + 6000);
		expect(its[0]?.risks).not.toContain("前日移動推奨");
	});
	test("早朝発の国際線には前日移動推奨リスクが付く", () => {
		const intl = ob({
			origin: "OSA",
			destination: "BKK",
			departAt: "2026-08-02T09:30",
			priceJpy: 8000,
		});
		const its = combine([intl], cfg).filter((i) => i.kind === "positioned");
		expect(its[0]?.risks).toContain("前日移動推奨");
	});
	test("FUK発はground表に無いので国内線観測が無ければ経路化されない", () => {
		const intl = ob({ origin: "FUK", destination: "BKK", priceJpy: 7000 });
		expect(
			combine([intl], cfg).filter((i) => i.kind === "positioned"),
		).toHaveLength(0);
	});
	test("FUK発+国内線観測があれば3レグ相当のpositioned成立", () => {
		const dom = ob({
			origin: "TYO",
			destination: "FUK",
			departAt: "2026-08-02T07:00",
			arriveAt: "2026-08-02T09:00",
			priceJpy: 5000,
		});
		const intl = ob({
			origin: "FUK",
			destination: "BKK",
			departAt: "2026-08-02T14:00",
			arriveAt: "2026-08-02T18:00",
			priceJpy: 7000,
		});
		const its = combine([dom, intl], cfg).filter(
			(i) => i.kind === "positioned",
		);
		expect(its).toHaveLength(1);
		expect(its[0]?.totalJpy).toBe(12000);
	});
	test("空港コードは都市に正規化され、DMK着もBKK扱いになる", () => {
		const its = combine(
			[ob({ origin: "NRT", destination: "DMK", priceJpy: 13000 })],
			cfg,
		);
		expect(its).toHaveLength(1);
		expect(its[0]?.kind).toBe("direct");
	});
	test("総額昇順・上位20件", () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			ob({ priceJpy: 10000 + i * 100, id: `d${i}` }),
		);
		const its = combine(many, cfg);
		expect(its).toHaveLength(20);
		expect(its[0]?.totalJpy).toBeLessThanOrEqual(its[19]?.totalJpy ?? 0);
	});
});

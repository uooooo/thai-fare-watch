import { describe, expect, test } from "bun:test";
import {
	parseBookingAria,
	parseBookingRows,
	parseGridAria,
	parsePriceJpy,
	parseResultRows,
} from "../src/sources/gf-browser/parse";
import bookingRowsRaw from "./fixtures/gf/booking-rows.json";
import gridLabels from "./fixtures/gf/grid-labels.json";
import resultRowLabels from "./fixtures/gf/result-rows.json";

// fixtureの出自(REAL/CONSTRUCTED)は test/fixtures/gf/README的な位置づけの記述を
// .superpowers/sdd/task-15-report.md に記載する(このリポジトリの規約でtest/配下には
// ドキュメントを置かない)。要旨: result-rows.jsonはheadless実キャプチャそのまま(REAL)、
// grid-labels.jsonは実キャプチャで裏付けた曜日を使ったCONSTRUCTED、booking-rows.jsonは
// 実キャプチャ3件+OTA構成確認用のCONSTRUCTED1件。

describe("parsePriceJpy", () => {
	test("¥14,980 → 14980", () => {
		expect(parsePriceJpy("¥14,980")).toBe(14980);
	});
	test("14,980円 → 14980", () => {
		expect(parsePriceJpy("14,980円")).toBe(14980);
	});
	test("全角￥14,980 → 14980", () => {
		expect(parsePriceJpy("￥14,980")).toBe(14980);
	});
	test("価格を含まない文字列はundefined", () => {
		expect(parsePriceJpy("残席わずか")).toBeUndefined();
		expect(parsePriceJpy("価格情報なし")).toBeUndefined();
	});
	// 万単位の省略/小数表記(例: 1.5万円=15,000円)は非対応。数字の直後が"."または"万"の場合、
	// 誤って先頭の整数部分だけ(例: "¥1.5万"→1)を実額として返してしまうバグがあったため、
	// 数字の直後にこれらが続く場合は明確にundefinedを返す(黒っぽく間違った値より、
	// 「パースできなかった」ことが分かる方が安全)。
	test("¥1.5万 → undefined(万単位の省略/小数表記は非対応)", () => {
		expect(parsePriceJpy("¥1.5万")).toBeUndefined();
	});
	test("1.2万円 → undefined(万単位の省略/小数表記は非対応)", () => {
		expect(parsePriceJpy("1.2万円")).toBeUndefined();
	});
});

describe("parseGridAria (CONSTRUCTED fixture: 実キャプチャの曜日で裏付け済み)", () => {
	const cells = parseGridAria(gridLabels as string[], 2026);

	test("価格ありセルのみ10件以上取れる(価格情報なしセルは除外)", () => {
		expect(cells.length).toBeGreaterThan(10);
	});

	test("各セルの日付はYYYY-MM-DD形式で年は引数と一致・価格は妥当な範囲", () => {
		for (const c of cells) {
			expect(c.date).toMatch(/^2026-\d{2}-\d{2}$/);
			expect(c.priceJpy).toBeGreaterThan(3000);
		}
	});

	test("「価格情報なし」セル(8/5, 8/9, 8/16)は結果に含まれない", () => {
		expect(cells.some((c) => c.date === "2026-08-05")).toBe(false);
		expect(cells.some((c) => c.date === "2026-08-09")).toBe(false);
		expect(cells.some((c) => c.date === "2026-08-16")).toBe(false);
	});

	test("先頭セル(8月1日)の日付・価格が正しく取れる", () => {
		expect(cells[0]).toEqual({ date: "2026-08-01", priceJpy: 32000 });
	});

	test("12月→1月跨ぎで年がインクリメントされる(手書きラベル、曜日は実キャプチャで裏付け)", () => {
		const rollover = parseGridAria(
			[
				"12月29日 火曜日、45000円",
				"12月30日 水曜日、48000円",
				"12月31日 木曜日、価格情報なし",
				"1月1日 金曜日、52000円",
				"1月2日 土曜日、49500円",
			],
			2026,
		);
		expect(rollover).toEqual([
			{ date: "2026-12-29", priceJpy: 45000 },
			{ date: "2026-12-30", priceJpy: 48000 },
			{ date: "2027-01-01", priceJpy: 52000 },
			{ date: "2027-01-02", priceJpy: 49500 },
		]);
	});
});

describe("parseResultRows (REAL fixture: NRT->BKK headless captureのaria-label)", () => {
	const rows = parseResultRows(
		(resultRowLabels as string[]).map((ariaLabel) => ({
			ariaLabel,
			departDate: "2026-08-18",
		})),
	);

	test("実キャプチャ18行すべてパースできる(パース不能0件)", () => {
		expect(rows.length).toBe((resultRowLabels as string[]).length);
	});

	test("直行便(ZIPAIR Tokyo)の主要フィールドが取れる", () => {
		const zip = rows.find((r) => r.airline === "ZIPAIR Tokyo");
		expect(zip).toBeDefined();
		expect(zip?.origin).toBe("NRT");
		expect(zip?.destination).toBe("BKK");
		expect(zip?.departDate).toBe("2026-08-18");
		expect(zip?.departAt).toBe("2026-08-18T17:00:00");
		expect(zip?.arriveAt).toBe("2026-08-18T21:40:00");
		expect(zip?.transfers).toBe(0);
		expect(zip?.priceJpy).toBe(36072);
		expect(zip?.flightNumber).toBeUndefined();
	});

	test("経由便(チェジュ航空)は乗継数1、到着日が2日後にロールオーバーする", () => {
		const jeju = rows.find((r) => r.airline === "チェジュ航空");
		expect(jeju).toBeDefined();
		expect(jeju?.transfers).toBe(1);
		expect(jeju?.departAt).toBe("2026-08-18T19:50:00");
		expect(jeju?.arriveAt).toBe("2026-08-20T00:10:00");
		expect(jeju?.priceJpy).toBe(37660);
	});

	test("コードシェア注記(「航空会社: Air Japan.」)を含む行も正しくパースできる", () => {
		const ana = rows.find((r) => r.airline === "ANA");
		expect(ana).toBeDefined();
		expect(ana?.priceJpy).toBe(210740);
		expect(ana?.transfers).toBe(0);
		expect(ana?.departAt).toBe("2026-08-18T19:20:00");
	});

	test("全行がpriceJpy>3000・airline非空・NRT/BKKのIATAコード", () => {
		expect(rows.length).toBeGreaterThan(2);
		for (const r of rows) {
			expect(r.priceJpy).toBeGreaterThan(3000);
			expect(r.airline).toBeTruthy();
			expect(r.origin).toBe("NRT");
			expect(r.destination).toBe("BKK");
			expect(r.departDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	test("発着/価格/直行乗継のいずれかが読み取れない行はスキップされthrowしない", () => {
		const got = parseResultRows([
			{
				ariaLabel: "この文字列にはaria-labelの想定構造がありません",
				departDate: "2026-08-18",
			},
			{ ariaLabel: "", departDate: "2026-08-18" },
			{
				// 価格はあるが発着/運航会社情報が無い
				ariaLabel: "36072 円～。 何かの説明文。",
				departDate: "2026-08-18",
			},
		]);
		expect(got).toEqual([]);
	});
});

describe("parseBookingAria (実キャプチャaria-label → {sellerText, priceText})", () => {
	test("実キャプチャ(ZIPAIR Tokyo、「航空会社」接頭辞つき)を分解できる", () => {
		const got = parseBookingAria(
			"航空会社 ZIPAIR Tokyo での予約手続きに進む（料金: 36072 円）",
		);
		expect(got).toEqual({ sellerText: "ZIPAIR Tokyo", priceText: "36072円" });
	});

	test("末尾の外貨換算注記(タイバーツ相当額)があっても価格を正しく切り出す", () => {
		const got = parseBookingAria(
			"航空会社 タイ・ベトジェット・エア での予約手続きに進む（料金: 36575 円） (タイ・ベトジェット・エア で 7569 タイ バーツ の相当額)",
		);
		expect(got).toEqual({
			sellerText: "タイ・ベトジェット・エア",
			priceText: "36575円",
		});
	});

	test("「航空会社」接頭辞が無いOTA名も分解できる(CONSTRUCTED: Trip.com)", () => {
		const got = parseBookingAria(
			"Trip.com での予約手続きに進む（料金: 15100 円）",
		);
		expect(got).toEqual({ sellerText: "Trip.com", priceText: "15100円" });
	});

	test("パターンに合わない文字列はundefined(throwしない)", () => {
		expect(parseBookingAria("よくわからない文字列")).toBeUndefined();
		expect(parseBookingAria("")).toBeUndefined();
	});
});

describe("parseBookingRows (実キャプチャ3件+OTA構成確認用CONSTRUCTED1件)", () => {
	const rows = (bookingRowsRaw as string[])
		.map(parseBookingAria)
		.filter(
			(r): r is { sellerText: string; priceText: string } => r !== undefined,
		);

	test("fixtureの4件全てがparseBookingAriaで分解できる(前段の健全性確認)", () => {
		expect(rows.length).toBe((bookingRowsRaw as string[]).length);
	});

	test("4件とも{seller, priceJpy}に正しく変換される", () => {
		const parsed = parseBookingRows(rows);
		expect(parsed).toEqual([
			{ seller: "ZIPAIR Tokyo", priceJpy: 36072 },
			{ seller: "タイ・ベトジェット・エア", priceJpy: 36575 },
			{ seller: "チェジュ航空", priceJpy: 37660 },
			{ seller: "Trip.com", priceJpy: 15100 },
		]);
	});

	test("sellerText/priceTextが空・パース不能な行はスキップされる", () => {
		const got = parseBookingRows([
			{ sellerText: "", priceText: "36072円" },
			{ sellerText: "ZIPAIR", priceText: "残席わずか" },
			{ sellerText: "Trip.com", priceText: "15,100円" },
		]);
		expect(got).toEqual([{ seller: "Trip.com", priceJpy: 15100 }]);
	});
});

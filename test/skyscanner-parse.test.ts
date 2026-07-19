import { describe, expect, test } from "bun:test";
import {
	parseAgencyRows,
	parsePriceJpy,
	parseSkyscannerCards,
} from "../src/sources/skyscanner/parse";
import agencyRowsRaw from "./fixtures/skyscanner/agency-rows.json";
import cardsRaw from "./fixtures/skyscanner/cards.json";

// fixtureの出自: いずれもCONSTRUCTED(Skyscanner ja-JPのドキュメント化された構造に基づく
// 手書き)。Task 15bのLive capture試行がブロックされた場合の扱いは
// .superpowers/sdd/task-15b-report.md に記載する(このリポジトリの規約でtest/配下には
// ドキュメントを置かない)。parseSkyscannerCards/parseAgencyRowsはこのfixtureで
// テストされる(実ブラウザ・実ネットワークは一切使わない)。

describe("parsePriceJpy (gf-browser/parseから再利用、drift防止のためimport)", () => {
	test("¥15,700 → 15700", () => {
		expect(parsePriceJpy("¥15,700")).toBe(15700);
	});
	test("価格を確認中 → undefined", () => {
		expect(parsePriceJpy("価格を確認中")).toBeUndefined();
	});
});

describe("parseSkyscannerCards (CONSTRUCTED fixture: cards.json)", () => {
	const rows = parseSkyscannerCards(
		cardsRaw as Parameters<typeof parseSkyscannerCards>[0],
	);

	test("6行中、価格または航空会社名が読み取れない2行はスキップされ4件残る", () => {
		expect(rows.length).toBe(4);
	});

	test("直行・出発時刻ありのZIPAIRカードが正しくパースされる", () => {
		const zip = rows.find((r) => r.airline === "ZIPAIR");
		expect(zip).toBeDefined();
		expect(zip?.origin).toBe("NRT");
		expect(zip?.destination).toBe("BKK");
		expect(zip?.departDate).toBe("2026-08-18");
		expect(zip?.departAt).toBe("2026-08-18T17:05:00");
		expect(zip?.transfers).toBe(0);
		expect(zip?.priceJpy).toBe(15700);
	});

	test("出発時刻が無いカード(大韓航空)はdepartAtがundefinedのまま他フィールドは取れる", () => {
		const koreanAir = rows.find((r) => r.airline === "大韓航空");
		expect(koreanAir).toBeDefined();
		expect(koreanAir?.departAt).toBeUndefined();
		expect(koreanAir?.transfers).toBe(1);
		expect(koreanAir?.priceJpy).toBe(21300);
	});

	test("乗り継ぎ2回のカードはtransfers=2になる", () => {
		const vj = rows.find((r) => r.airline === "ベトジェットエア");
		expect(vj).toBeDefined();
		expect(vj?.transfers).toBe(2);
	});

	test("価格が「価格を確認中」で確定していない行はスキップされる(Scoot)", () => {
		expect(rows.find((r) => r.airline === "Scoot")).toBeUndefined();
	});

	test("航空会社名が空文字の行はスキップされる", () => {
		expect(rows.some((r) => r.priceJpy === 14980)).toBe(false);
	});

	test("パース不能な入力を渡してもthrowしない(空配列/不正な行)", () => {
		expect(() =>
			parseSkyscannerCards([
				{
					origin: "NRT",
					destination: "BKK",
					departDate: "2026-08-18",
					airlineText: "",
					transfersText: "",
					priceText: "",
				},
			]),
		).not.toThrow();
		expect(parseSkyscannerCards([])).toEqual([]);
	});
});

describe("parseAgencyRows (CONSTRUCTED fixture: agency-rows.json、Recommended Providerバッジ)", () => {
	const rows = parseAgencyRows(
		agencyRowsRaw as Parameters<typeof parseAgencyRows>[0],
	);

	test("5行全てがseller/priceJpy/recommendedBadgeを持つ(パース不能0件)", () => {
		expect(rows.length).toBe(5);
	});

	test("「おすすめの提供会社」バッジのある行はrecommendedBadge=true", () => {
		const hub = rows.find((r) => r.seller === "TravelHub");
		expect(hub).toEqual({
			seller: "TravelHub",
			priceJpy: 8750,
			recommendedBadge: true,
		});
	});

	test("バッジ無しの行はrecommendedBadge=false(allowlist済みOTAでも同様、判定はparse層の関心外)", () => {
		expect(rows.find((r) => r.seller === "Trip.com")).toEqual({
			seller: "Trip.com",
			priceJpy: 9200,
			recommendedBadge: false,
		});
		expect(rows.find((r) => r.seller === "GoFlyCheap")).toEqual({
			seller: "GoFlyCheap",
			priceJpy: 8600,
			recommendedBadge: false,
		});
		expect(rows.find((r) => r.seller === "Thai AirAsia")).toEqual({
			seller: "Thai AirAsia",
			priceJpy: 8990,
			recommendedBadge: false,
		});
	});

	test("Recommended関連の文言を含まないバッジ文言はrecommendedBadge=false(誤検出しない)", () => {
		expect(rows.find((r) => r.seller === "BudgetTrips")).toEqual({
			seller: "BudgetTrips",
			priceJpy: 8500,
			recommendedBadge: false,
		});
	});

	test("英語表記「Recommended」も認識する", () => {
		const got = parseAgencyRows([
			{ agency: "SomeAgency", priceText: "¥9,000", badgeText: "Recommended" },
		]);
		expect(got).toEqual([
			{ seller: "SomeAgency", priceJpy: 9000, recommendedBadge: true },
		]);
	});

	test("「信頼できる」表記も認識する", () => {
		const got = parseAgencyRows([
			{
				agency: "AnotherAgency",
				priceText: "¥9,500",
				badgeText: "信頼できる提供会社",
			},
		]);
		expect(got).toEqual([
			{ seller: "AnotherAgency", priceJpy: 9500, recommendedBadge: true },
		]);
	});

	test("agency名や価格が空・パース不能な行はスキップされる(throwしない)", () => {
		const got = parseAgencyRows([
			{ agency: "", priceText: "¥8,000" },
			{ agency: "NoPriceAgency", priceText: "価格未定" },
			{ agency: "ValidAgency", priceText: "8,000円" },
		]);
		expect(got).toEqual([
			{ seller: "ValidAgency", priceJpy: 8000, recommendedBadge: false },
		]);
	});
});

// なりすまし対策(レビュー指摘のCritical): バッジテキストが行テキスト全体で汚染され
// 販売元名そのものを含む場合、代理店が自らを「おすすめ〜」等と名乗るだけで信頼扱いに
// 昇格できてしまう。parse層の汚染ガードでこれを遮断する。
describe("parseAgencyRows なりすまし対策(バッジ文字列が販売元名を内包→無効)", () => {
	test("CJK名に推奨語を含めても、バッジが名前を内包していればrecommendedBadge=false", () => {
		const got = parseAgencyRows([
			{
				agency: "おすすめ激安トラベル",
				priceText: "¥8,500",
				badgeText: "おすすめ激安トラベル ¥8,500",
			},
		]);
		expect(got[0]?.recommendedBadge).toBe(false);
	});
	test("英語名に Recommended を含めても、バッジが名前を内包していればfalse", () => {
		const got = parseAgencyRows([
			{
				agency: "Recommended Travel Deals",
				priceText: "¥7,900",
				badgeText: "Recommended Travel Deals ¥7,900",
			},
		]);
		expect(got[0]?.recommendedBadge).toBe(false);
	});
	test("「信頼できる」を名乗る代理店も、バッジが名前を内包していればfalse", () => {
		const got = parseAgencyRows([
			{
				agency: "信頼できる格安ツアー",
				priceText: "¥9,100",
				badgeText: "信頼できる格安ツアー ¥9,100",
			},
		]);
		expect(got[0]?.recommendedBadge).toBe(false);
	});
	test("販売元名を含まない独立したバッジ文言なら、非allowlist代理店でもtrueになる", () => {
		const got = parseAgencyRows([
			{
				agency: "GoodAgency",
				priceText: "¥8,000",
				badgeText: "おすすめの提供会社",
			},
		]);
		expect(got[0]).toEqual({
			seller: "GoodAgency",
			priceJpy: 8000,
			recommendedBadge: true,
		});
	});
});

import { describe, expect, test } from "bun:test";
import {
	applyTrust,
	bestTrustedSeller,
	classifySeller,
	normalizeSeller,
} from "../src/core/trust";
import type { VerifiedOffer } from "../src/types";

const trusted = ["trip.com", "booking.com"];

describe("normalizeSeller", () => {
	test("「ZIPAIRで予約」→ zipair", () =>
		expect(normalizeSeller("ZIPAIRで予約")).toBe("zipair"));
	test("Trip.com → tripcom（記号除去）", () =>
		expect(normalizeSeller("Trip.com")).toBe("tripcom"));
});

describe("classifySeller", () => {
	test("SerpAPIのairlineフラグは無条件でairline", () => {
		expect(
			classifySeller(
				{ seller: "Gotogate", isAirlineDirectHint: true, legAirlines: [] },
				trusted,
			),
		).toBe("airline");
	});
	test("販売元名が運航会社名と一致→airline（GFブラウザ経路）", () => {
		expect(
			classifySeller(
				{ seller: "Thai AirAsia Xで予約", legAirlines: ["Thai AirAsia X"] },
				trusted,
			),
		).toBe("airline");
	});
	// 実運用検証で発見: Google Flightsは直販の販売元を「ZIPAIR Tokyo」等と表記するため、
	// 運航会社名"ZIPAIR"と完全一致せず、完全一致のみだとLCC直販(¥1万級の主役)を全て取り
	// こぼす。seller ⊇ airline(運航会社名4文字以上)の内包判定で直販として拾う。
	test("販売元名が運航会社名を内包→airline（ZIPAIR Tokyo ⊇ ZIPAIR）", () => {
		expect(
			classifySeller(
				{ seller: "ZIPAIR Tokyo", legAirlines: ["ZIPAIR"] },
				trusted,
			),
		).toBe("airline");
		expect(
			classifySeller(
				{ seller: "AirAsia (エアアジア)", legAirlines: ["AirAsia"] },
				trusted,
			),
		).toBe("airline");
	});
	test("短い部分文字列の逆方向なりすまし(seller ⊂ airline)は引き続き遮断（T9）", () => {
		for (const seller of ["ZIP", "Air", "Thai", "Z", "AIR"]) {
			expect(
				classifySeller(
					{ seller, legAirlines: ["ZIPAIR", "Thai AirAsia X"] },
					trusted,
				),
			).toBe("reference");
		}
	});
	test("短い運航会社名(4文字未満)は無関係な販売元名に偶然内包されても誤判定しない", () => {
		expect(
			classifySeller({ seller: "Museum Tours", legAirlines: ["US"] }, trusted),
		).toBe("reference");
	});
	test("trusted OTAは部分一致（trip.com）", () => {
		expect(
			classifySeller(
				{ seller: "Trip.com (トリップドットコム)", legAirlines: ["ZIPAIR"] },
				trusted,
			),
		).toBe("trusted_ota");
	});
	test("Agoda・無名OTAはreference", () => {
		expect(classifySeller({ seller: "Agoda", legAirlines: [] }, trusted)).toBe(
			"reference",
		);
		expect(classifySeller({ seller: "Mytrip", legAirlines: [] }, trusted)).toBe(
			"reference",
		);
	});

	// 追加テスト(a): 正規化後に空文字となる販売元名の空文字ガード。
	// 「格安トラベル」「ゼットジップ」はいずれも[a-z0-9]を1文字も含まないため、
	// normalizeSellerは両方とも空文字を返す。ガードが無いと"".includes("")===trueで
	// 無条件にairline判定されてしまうため、reference（不一致）になることを確認する。
	test("正規化後に空文字となる販売元は運航会社名と誤マッチしない（空文字ガード）", () => {
		expect(
			classifySeller(
				{ seller: "格安トラベル", legAirlines: ["ゼットジップ"] },
				trusted,
			),
		).toBe("reference");
	});

	test("類似名OTAは信頼されない（Mytrip.com ⊅ trip.com）", () => {
		expect(
			classifySeller({ seller: "Mytrip.com", legAirlines: [] }, trusted),
		).toBe("reference");
		expect(
			classifySeller({ seller: "eBooking.com", legAirlines: [] }, trusted),
		).toBe("reference");
		expect(
			classifySeller({ seller: "gotogate-trip.com", legAirlines: [] }, trusted),
		).toBe("reference");
	});
	// ラテン接尾辞は設定で明示追加が必要。"Trip.com (Japan)"は正規化後"tripcomjapan"と
	// なり"tripcom"と完全一致しないためreferenceに転ぶ（安全側）。一方"Booking.com フライト"は
	// CJK部分（フライト）が正規化で消えるため"bookingcom"と完全一致し、trusted_otaのまま。
	test("ラテン接尾辞は設定で明示追加が必要（CJK装飾は正規化で消えるため信頼されたまま）", () => {
		expect(
			classifySeller({ seller: "Trip.com (Japan)", legAirlines: [] }, trusted),
		).toBe("reference");
		expect(
			classifySeller(
				{ seller: "Booking.com フライト", legAirlines: [] },
				trusted,
			),
		).toBe("trusted_ota");
	});

	// Finding(Critical): rule 2が包含判定だった当時、短い部分文字列のsellerが
	// legAirlinesの一部にcontainsされることで無条件にairline誤判定されていた
	// （例: seller "ZIP" ⊂ legAirlines "ZIPAIR"）。完全一致のみに厳格化したことの回帰テスト。
	test("短い部分文字列では直販判定されない", () => {
		for (const seller of ["ZIP", "Air", "Thai", "Z", "AIR"]) {
			expect(
				classifySeller(
					{ seller, legAirlines: ["ZIPAIR", "Thai AirAsia X"] },
					trusted,
				),
			).toBe("reference");
		}
	});

	// Finding(Important): rule 3が前方一致(startsWith)判定だった当時、trusted OTA名を
	// 前置しただけの別名（seller）がtrusted_otaに誤判定されていた
	// （例: "trip.com.evil-agency" → 正規化後"tripcomevilagency"が"tripcom"の前方一致）。
	// 完全一致のみに厳格化したことの回帰テスト。
	test("trusted OTA名を前置した別名は信頼されない", () => {
		expect(
			classifySeller(
				{ seller: "trip.com.evil-agency", legAirlines: [] },
				trusted,
			),
		).toBe("reference");
		expect(
			classifySeller(
				{ seller: "TripCom Travel Deals LLC", legAirlines: [] },
				trusted,
			),
		).toBe("reference");
		expect(
			classifySeller(
				{ seller: "Booking.com-scam-network", legAirlines: [] },
				trusted,
			),
		).toBe("reference");
	});
});

// Task 15b追加(additive): classifySellerのrecommendedBadge引数(Skyscannerの
// 「おすすめの提供会社」バッジ)。既存のrule 1/2/4/5は一切変更していないので、
// badgeを渡さない既存呼び出し(上のdescribeブロック全て)は挙動が変わらないことが前提。
describe("classifySeller (recommendedBadge, Task 15b additive)", () => {
	test("badge=trueかつallowlist外の未知agency→trusted_ota", () => {
		expect(
			classifySeller(
				{ seller: "TravelHub", legAirlines: [], recommendedBadge: true },
				trusted,
			),
		).toBe("trusted_ota");
	});

	test("badge=falseかつ未知agency→reference（バッジが無ければ普段通り）", () => {
		expect(
			classifySeller(
				{ seller: "TravelHub", legAirlines: [], recommendedBadge: false },
				trusted,
			),
		).toBe("reference");
	});

	test("recommendedBadge省略(既存呼び出し)は従来通りreference", () => {
		expect(
			classifySeller({ seller: "TravelHub", legAirlines: [] }, trusted),
		).toBe("reference");
	});

	// バッジはrule 3として rule 1/2(airline判定)より後に評価されるため、運航会社直販の
	// 判定を上書きできない —航空会社自身がおすすめ表示されても常にairline側が優先される。
	test("badge=trueでも運航会社名と完全一致するsellerはairlineのまま(バッジはrule1/2を上書きしない)", () => {
		expect(
			classifySeller(
				{
					seller: "ZIPAIRで予約",
					legAirlines: ["ZIPAIR"],
					recommendedBadge: true,
				},
				trusted,
			),
		).toBe("airline");
	});

	test("badge=trueでもisAirlineDirectHint===trueが優先されairlineのまま", () => {
		expect(
			classifySeller(
				{
					seller: "Gotogate",
					isAirlineDirectHint: true,
					legAirlines: [],
					recommendedBadge: true,
				},
				trusted,
			),
		).toBe("airline");
	});

	// バッジはallowlist一致(rule 4)と同格 —すでにallowlistに載っているOTAにバッジが
	// 付いても、付かなくても、結果は変わらずtrusted_ota(rule 3とrule 4のどちらかで到達)。
	test("allowlist済みOTAはbadge有無に関わらずtrusted_ota", () => {
		expect(
			classifySeller(
				{ seller: "Trip.com", legAirlines: [], recommendedBadge: true },
				trusted,
			),
		).toBe("trusted_ota");
		expect(
			classifySeller(
				{ seller: "Trip.com", legAirlines: [], recommendedBadge: false },
				trusted,
			),
		).toBe("trusted_ota");
	});
});

// 追加テスト(b): applyTrust + bestTrustedSellerのend-to-end。
// airline直販（最高値）・trusted OTA（中間値）・reference（全体最安）が混在する
// VerifiedOfferに対し、bestTrustedSellerが「trust!=="reference"の中の最安」である
// trusted OTAを返すこと（全体最安のreferenceを誤って返さないこと）を確認する。
describe("applyTrust / bestTrustedSeller", () => {
	const baseOffer = (over: Partial<VerifiedOffer> = {}): VerifiedOffer => ({
		id: "x",
		source: "serpapi",
		origin: "NRT",
		destination: "BKK",
		departDate: "2026-08-02",
		transfers: 0,
		priceJpy: 30000,
		market: "jp",
		foundAt: new Date().toISOString(),
		airline: "ZIPAIR",
		sellers: [],
		...over,
	});

	test("混在するsellerを再分類し、最安のtrusted(reference以外)を返す", () => {
		const offer = baseOffer({
			sellers: [
				{
					seller: "ZIPAIRで予約",
					// 元のヒントがfalseでも、leg一致（airline===seller）で再判定される。
					isAirlineDirect: false,
					trust: "reference",
					priceJpy: 55000,
				},
				{
					seller: "Trip.com (トリップドットコム)",
					isAirlineDirect: false,
					trust: "reference",
					priceJpy: 45000,
				},
				{
					seller: "Agoda",
					isAirlineDirect: false,
					trust: "reference",
					priceJpy: 30000, // 全体最安だがreferenceなのでbestTrustedSellerの対象外
				},
			],
		});

		const verified = applyTrust(offer, trusted);

		expect(verified.sellers.map((s) => s.trust)).toEqual([
			"airline",
			"trusted_ota",
			"reference",
		]);
		expect(verified.sellers[0]?.isAirlineDirect).toBe(true);
		expect(verified.sellers[1]?.isAirlineDirect).toBe(false);
		expect(verified.sellers[2]?.isAirlineDirect).toBe(false);

		const best = bestTrustedSeller(verified);
		expect(best?.seller).toBe("Trip.com (トリップドットコム)");
		expect(best?.priceJpy).toBe(45000);
	});

	test("trust!==referenceのsellerが無ければundefined", () => {
		const offer = baseOffer({
			sellers: [
				{
					seller: "Agoda",
					isAirlineDirect: false,
					trust: "reference",
					priceJpy: 30000,
				},
			],
		});
		expect(bestTrustedSeller(applyTrust(offer, trusted))).toBeUndefined();
	});
});

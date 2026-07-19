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
	test("前方一致の表記ゆれは信頼される", () => {
		expect(
			classifySeller({ seller: "Trip.com (Japan)", legAirlines: [] }, trusted),
		).toBe("trusted_ota");
		expect(
			classifySeller(
				{ seller: "Booking.com フライト", legAirlines: [] },
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

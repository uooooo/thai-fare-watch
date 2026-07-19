import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { verifyItinerary } from "../src/core/verify";
import type { FareObservation, Itinerary, VerifiedOffer } from "../src/types";

const cfg = loadConfig({ env: {} });
const env = {
	isCI: false,
	hasBrowser: true,
	now: new Date("2026-07-18T10:00:00Z"),
};

const leg: FareObservation = {
	id: "leg-1",
	source: "travelpayouts",
	origin: "TYO",
	destination: "BKK",
	departDate: "2026-08-02",
	flightNumber: "TG601",
	transfers: 0,
	priceJpy: 10000,
	market: "jp",
	foundAt: env.now.toISOString(),
};
const baseIt: Itinerary = {
	id: "it-1",
	kind: "direct",
	legs: [leg],
	totalJpy: leg.priceJpy,
	fxFeeJpy: 0,
	risks: [],
	verification: "unverified",
};

function fliMock(offers: VerifiedOffer[]) {
	return {
		name: "fli",
		available: () => true,
		verify: async (): Promise<VerifiedOffer[]> => offers,
	};
}

describe("verifyItinerary matchOffer fallback (I5)", () => {
	test("flightNumber不一致でも±20%価格帯内なら最安にフォールバックしてマッチする", async () => {
		const offers: VerifiedOffer[] = [
			{ ...leg, id: "o1", flightNumber: "TG999", priceJpy: 11000, sellers: [] }, // 帯内(diff=1000<=2000)
			{ ...leg, id: "o2", flightNumber: "TG998", priceJpy: 20000, sellers: [] }, // 帯外(diff=10000>2000)
		];
		const fli = fliMock(offers);
		const { itinerary } = await verifyItinerary(baseIt, {
			sources: [fli],
			env,
			cfg,
		});
		expect(itinerary.verification).toBe("price_confirmed");
		const updatedLeg = itinerary.legs[0] as FareObservation;
		expect(updatedLeg.priceJpy).toBe(11000);
	});

	test("価格帯(±20%)の外だとマッチせず、unverifiedへ新オブジェクトで復帰する(Minor#7)", async () => {
		const offers: VerifiedOffer[] = [
			{ ...leg, id: "o3", flightNumber: "TG999", priceJpy: 20000, sellers: [] }, // 帯外
		];
		const fli = fliMock(offers);
		const { itinerary } = await verifyItinerary(baseIt, {
			sources: [fli],
			env,
			cfg,
		});
		expect(itinerary.verification).toBe("unverified");
		expect(itinerary).not.toBe(baseIt); // Minor#7: 元の参照ではなく新規オブジェクト
		expect(itinerary.legs).toEqual(baseIt.legs); // 内容自体は無変更
	});

	test("同便名の完全一致があれば価格帯マッチより優先する", async () => {
		const offers: VerifiedOffer[] = [
			{ ...leg, id: "o4", flightNumber: "TG601", priceJpy: 9500, sellers: [] }, // 完全一致
			{ ...leg, id: "o5", flightNumber: "TG999", priceJpy: 10000, sellers: [] }, // 帯内だが便名不一致
		];
		const fli = fliMock(offers);
		const { itinerary } = await verifyItinerary(baseIt, {
			sources: [fli],
			env,
			cfg,
		});
		const updatedLeg = itinerary.legs[0] as FareObservation;
		expect(updatedLeg.priceJpy).toBe(9500);
	});
});

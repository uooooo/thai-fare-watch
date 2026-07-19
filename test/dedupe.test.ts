import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
	assignTier,
	dealKey,
	expireDeals,
	shouldNotify,
} from "../src/core/dedupe";
import type { Itinerary } from "../src/types";

const cfg = loadConfig({ env: {} });
const it = (over: Partial<Itinerary>): Itinerary => ({
	id: "i1",
	kind: "direct",
	legs: [],
	totalJpy: 14000,
	fxFeeJpy: 0,
	risks: [],
	verification: "verified",
	...over,
});
const now = new Date("2026-07-18T00:00:00Z");

describe("assignTier", () => {
	test("verified 9,800→flash / 14,000→deal / 15,001→なし", () => {
		expect(assignTier(it({ totalJpy: 9800 }), cfg)).toBe("flash");
		expect(assignTier(it({ totalJpy: 14000 }), cfg)).toBe("deal");
		expect(assignTier(it({ totalJpy: 15001 }), cfg)).toBeUndefined();
	});
	test("price_confirmedはflash圏でもcandidate", () => {
		expect(
			assignTier(it({ totalJpy: 9800, verification: "price_confirmed" }), cfg),
		).toBe("candidate");
	});
});

describe("shouldNotify", () => {
	const k = "TYO-BKK|2026-08-02||trusted";
	test("初出→true", () =>
		expect(shouldNotify(it({}), k, undefined, now)).toBe(true));
	test("小幅値下がり(300円)→false、3%以上→true", () => {
		const last = { priceJpy: 14000, at: "2026-07-17T00:00:00Z", tier: "deal" };
		expect(shouldNotify(it({ totalJpy: 13700 }), k, last, now)).toBe(false);
		expect(shouldNotify(it({ totalJpy: 13400 }), k, last, now)).toBe(true); // -600 ≥ max(500, 420)
	});
	test("candidate→verified昇格はtrue", () => {
		const last = {
			priceJpy: 14000,
			at: "2026-07-17T00:00:00Z",
			tier: "candidate",
		};
		expect(
			shouldNotify(
				it({ totalJpy: 14000, tier: "deal" } as Itinerary),
				k,
				last,
				now,
			),
		).toBe(true);
	});
});

test("expireDealsは出発日超過を落とす", () => {
	const a = it({
		legs: [
			{
				id: "l",
				source: "fli",
				origin: "TYO",
				destination: "BKK",
				departDate: "2026-07-17",
				transfers: 0,
				priceJpy: 1,
				market: "jp",
				foundAt: "x",
			},
		],
	});
	expect(expireDeals([a], "2026-07-18")).toEqual([]);
});

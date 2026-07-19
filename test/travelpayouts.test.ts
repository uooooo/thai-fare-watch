import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { TravelpayoutsSource } from "../src/sources/travelpayouts";
import fixture from "./fixtures/tp-prices-for-dates.json";

const cfg = loadConfig({ env: { TRAVELPAYOUTS_TOKEN: "tp-test" } });
const env = {
	isCI: true,
	hasBrowser: false,
	now: new Date("2026-07-18T00:00:00Z"),
};

describe("TravelpayoutsSource", () => {
	test("tokenが無ければavailable=false", () => {
		const s = new TravelpayoutsSource(loadConfig({ env: {} }));
		expect(s.available(env)).toBe(false);
	});
	test("sweepはURLにtoken/market/currency/月を含め、FareObservationへ変換", async () => {
		const urls: string[] = [];
		const f = (async (u: string | URL | Request) => {
			urls.push(String(u));
			return Response.json(fixture);
		}) as unknown as typeof fetch;
		const s = new TravelpayoutsSource(cfg, {
			fetchImpl: f,
			sleep: async () => {},
		});
		const got = await s.sweep(
			[
				{ origin: "TYO", destination: "BKK", market: "jp" },
				{ origin: "SEL", destination: "BKK", market: "kr" },
			],
			{ from: "2026-08-01", to: "2026-08-31" },
		);
		expect(urls[0]).toContain("origin=TYO");
		expect(urls[0]).toContain("market=jp");
		expect(urls[0]).toContain("currency=jpy");
		expect(urls[0]).toContain("departure_at=2026-08");
		expect(urls[0]).toContain("one_way=true");
		expect(urls[1]).toContain("market=kr");
		const o = got[0];
		if (!o) throw new Error("expected at least one observation");
		expect(o.source).toBe("travelpayouts");
		expect(o.priceJpy).toBe(14980);
		expect(o.departDate).toBe("2026-08-02");
		expect(o.departAt).toBe("2026-08-02T09:15:00+09:00");
		expect(o.market).toBe("jp");
		expect(o.expiresAt).toBeDefined();
		expect(o.id).toMatch(/^[0-9a-f]{12}$/);
	});
	test("範囲外の日付・successでない応答は捨てる", async () => {
		const f = (async () =>
			Response.json({
				success: true,
				data: fixture.data,
			})) as unknown as typeof fetch;
		const s = new TravelpayoutsSource(cfg, {
			fetchImpl: f,
			sleep: async () => {},
		});
		const got = await s.sweep(
			[{ origin: "TYO", destination: "BKK", market: "jp" }],
			{ from: "2026-08-03", to: "2026-08-31" },
		);
		expect(got.map((o) => o.departDate)).toEqual(["2026-08-05"]); // 08-02は範囲外
	});
});

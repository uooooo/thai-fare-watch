import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { QuotaManager, SerpApiSource } from "../src/sources/serpapi";
import { Store } from "../src/state/store";
import booking from "./fixtures/serpapi-booking-options.json";
import search from "./fixtures/serpapi-search.json";

const cfg = loadConfig({ env: { SERPAPI_API_KEY: "sa-test" } });
const now = new Date("2026-07-18T03:00:00Z");
const store = () => new Store(mkdtempSync(join(tmpdir(), "tfw-")));

describe("QuotaManager", () => {
	test("日次予算 = min(残/残日数, cap)", () => {
		const st = store();
		st.writeQuota({ month: "2026-07", used: 200 });
		const q = new QuotaManager(st, cfg, now); // 残50, 7月残14日 → ceil(50/14)=4
		expect(q.dailyBudget()).toBe(4);
	});
	test("tryConsumeは月上限で拒否", () => {
		const st = store();
		st.writeQuota({ month: "2026-07", used: 249 });
		const q = new QuotaManager(st, cfg, now);
		expect(q.tryConsume(2)).toBe(false);
		expect(q.tryConsume(1)).toBe(true);
		expect(st.readQuota().used).toBe(250);
	});
	test("月が替わるとリセット", () => {
		const st = store();
		st.writeQuota({ month: "2026-06", used: 250 });
		expect(new QuotaManager(st, cfg, now).remainingMonth()).toBe(250);
	});
});

describe("SerpApiSource", () => {
	test("verifyは検索+booking optionsでsellers付きofferを返す", async () => {
		const urls: string[] = [];
		const f = (async (u: string | URL | Request) => {
			const url = String(u);
			urls.push(url);
			return Response.json(url.includes("booking_token") ? booking : search);
		}) as unknown as typeof fetch;
		const s = new SerpApiSource(cfg, { store: store(), fetchImpl: f, now });
		const got = await s.verify(
			{ origin: "NRT", destination: "BKK", market: "jp" },
			"2026-08-02",
		);
		expect(urls[0]).toContain("engine=google_flights");
		expect(urls[0]).toContain("currency=JPY");
		expect(urls[0]).toContain("gl=jp");
		expect(urls[0]).toContain("type=2"); // 片道
		const best = got.find((o) => o.flightNumber === "XJ 601");
		if (!best) throw new Error("expected XJ 601 offer");
		expect(best.sellers.map((s) => s.seller)).toEqual([
			"ZIPAIR",
			"Trip.com",
			"Gotogate",
		]);
		expect(best.sellers[0]?.isAirlineDirect).toBe(true);
	});
	test("booking optionsは最安便のみ（クォータ節約）で、quotaが2消費される", async () => {
		const st = store();
		const f = (async (u: string | URL | Request) =>
			Response.json(
				String(u).includes("booking_token") ? booking : search,
			)) as unknown as typeof fetch;
		const s = new SerpApiSource(cfg, { store: st, fetchImpl: f, now });
		await s.verify(
			{ origin: "NRT", destination: "BKK", market: "jp" },
			"2026-08-02",
		);
		expect(st.readQuota().used).toBe(2);
	});
	test("予算切れならavailable=false", () => {
		const st = store();
		st.writeQuota({ month: "2026-07", used: 250 });
		const s = new SerpApiSource(cfg, { store: st, now });
		expect(s.available({ isCI: true, hasBrowser: false, now })).toBe(false);
	});
});

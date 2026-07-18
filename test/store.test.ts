import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store";
import type { FareObservation } from "../src/types";

const obs = (over: Partial<FareObservation>): FareObservation => ({
	id: "x",
	source: "travelpayouts",
	origin: "TYO",
	destination: "BKK",
	departDate: "2026-08-02",
	transfers: 0,
	priceJpy: 14000,
	market: "jp",
	foundAt: new Date().toISOString(),
	...over,
});

describe("Store", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "tfw-"));
	test("stateは無ければ空既定・書けば読める", () => {
		const s = new Store(dir());
		expect(s.readState().lastRuns).toEqual({});
		s.writeState({
			...s.readState(),
			lastRuns: { "window:near": "2026-07-18T00:00:00Z" },
		});
		expect(s.readState().lastRuns["window:near"]).toBe("2026-07-18T00:00:00Z");
	});
	test("faresは月別JSONLに追記され、readRecentFaresが期限で絞る", () => {
		const s = new Store(dir());
		const fresh = obs({ id: "a" });
		const stale = obs({
			id: "b",
			foundAt: new Date(Date.now() - 72 * 3600e3).toISOString(),
		});
		s.appendFares([fresh, stale]);
		const got = s.readRecentFares(48);
		expect(got.map((o) => o.id)).toEqual(["a"]);
	});
	test("quota既定は当月used=0", () => {
		const s = new Store(dir());
		expect(s.readQuota().used).toBe(0);
	});
	test("notifiedは同キーの最新を返す", () => {
		const s = new Store(dir());
		s.appendNotified({
			dealKey: "k1",
			priceJpy: 14000,
			at: "2026-07-18T00:00:00Z",
			tier: "deal",
		});
		s.appendNotified({
			dealKey: "k1",
			priceJpy: 13000,
			at: "2026-07-18T06:00:00Z",
			tier: "deal",
		});
		expect(s.readNotified().k1?.priceJpy).toBe(13000);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { runWatchOnce } from "../src/core/pipeline";
import { RssSignal } from "../src/signals/rss";
import { Store } from "../src/state/store";
import type { FareObservation, VerifiedOffer } from "../src/types";

const cfg = loadConfig({
	env: { DISCORD_WEBHOOK_URL: "https://discord.example/wh" },
});
const now = new Date("2026-07-18T10:00:00Z");
const cheapObs: FareObservation = {
	id: "cheap1",
	source: "travelpayouts",
	origin: "TYO",
	destination: "BKK",
	departDate: "2026-08-02",
	transfers: 0,
	priceJpy: 13000,
	market: "jp",
	foundAt: now.toISOString(),
};
const mockSweep = {
	name: "mock-sweep",
	available: () => true,
	sweep: async () => [cheapObs],
};
const mockVerify = {
	name: "mock-verify",
	available: () => true,
	verify: async (): Promise<VerifiedOffer[]> => [
		{
			...cheapObs,
			source: "serpapi",
			sellers: [
				{
					seller: "ZIPAIR",
					isAirlineDirect: true,
					trust: "airline",
					priceJpy: 13000,
				},
			],
		},
	],
};
const rssEmpty = new RssSignal(cfg, {
	fetchImpl: (async () =>
		new Response("<rss><channel></channel></rss>")) as unknown as typeof fetch,
});

describe("runWatchOnce", () => {
	test("掃引→合成→検証→通知が貫通し、stateが更新される", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const sent: string[] = [];
		const notifier = {
			send: async (embeds: object[]) => {
				sent.push(JSON.stringify(embeds));
			},
		};
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [mockSweep, mockVerify] as never,
			rss: rssEmpty,
			notifier: notifier as never,
		});
		expect(r.errors).toEqual([]);
		expect(r.observations).toBeGreaterThan(0);
		expect(r.notified).toBe(1);
		expect(sent[0]).toContain("13,000");
		expect(store.readDeals().length).toBeGreaterThan(0);
		expect(Object.keys(store.readState().lastRuns)).toContain(
			"window:immediate",
		);
		// 再実行: 窓は期限前・同dealは再通知されない
		const r2 = await runWatchOnce({
			cfg,
			store,
			env: {
				isCI: true,
				hasBrowser: false,
				now: new Date(now.getTime() + 60e3),
			},
			sources: [mockSweep, mockVerify] as never,
			rss: rssEmpty,
			notifier: notifier as never,
		});
		expect(r2.notified).toBe(0);
	});
	test("dryRunは通知もstate書き込みもしない", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [mockSweep, mockVerify] as never,
			rss: rssEmpty,
			dryRun: true,
		});
		expect(r.notified).toBe(1); // 「通知され得た」件数は返す
		expect(store.readDeals()).toEqual([]);
		expect(store.readState().lastRuns).toEqual({});
	});
	test("ソース例外はerrorsに載り継続する", async () => {
		const boom = {
			name: "boom",
			available: () => true,
			sweep: async () => {
				throw new Error("api down");
			},
		};
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [boom, mockSweep, mockVerify] as never,
			rss: rssEmpty,
			dryRun: true,
		});
		expect(r.errors.some((e) => e.includes("boom"))).toBe(true);
		expect(r.observations).toBeGreaterThan(0);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { runWatchOnce } from "../src/core/pipeline";
import { RssSignal } from "../src/signals/rss";
import { Store } from "../src/state/store";
import type { FareObservation, VerifiedOffer } from "../src/types";
import { HttpError } from "../src/util/http";

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

	test("上位5件を超える適格候補はverifyQueueに積まれる(C2)", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const prices = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
		const obsList: FareObservation[] = prices.map((p, i) => ({
			id: `c2-${i}`,
			source: "travelpayouts",
			origin: "TYO",
			destination: "BKK",
			departDate: "2026-08-02",
			transfers: 0,
			priceJpy: p,
			market: "jp",
			foundAt: now.toISOString(),
		}));
		// sweepのみ・verify能力を持つソースが無い(=誰も"verified"に到達できない)。
		const sweepOnly = {
			name: "mock-sweep-8",
			available: () => true,
			sweep: async () => obsList,
		};
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [sweepOnly] as never,
			rss: rssEmpty,
		});
		expect(r.errors).toEqual([]);
		// 既存挙動: tierが付くのは検証バッチ(先頭5件)のみ→5件通知。
		expect(r.notified).toBe(5);
		// 新規: バッチの外にいた3件(6000/7000/8000)がverifyQueueへ積まれる。
		// (itinerary.idはobservation.idのハッシュなので、priceJpyで内容を照合する)
		const queue = store.readState().verifyQueue;
		expect(queue.length).toBe(3);
		const deals = store.readDeals();
		// キューのidは必ずこの回writeDealsされたdeals.jsonの中に存在する。
		for (const id of queue) {
			expect(deals.some((d) => d.id === id)).toBe(true);
		}
		const queuedPrices = queue.map(
			(id) => deals.find((d) => d.id === id)?.totalJpy,
		);
		expect(queuedPrices).toEqual([6000, 7000, 8000]); // 安い順(cheapest-first)を保持
	});

	test("RSSマッチはimmediate/near窓を強制dueにする(I3)", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const recentLastRun = new Date(now.getTime() - 5 * 60e3).toISOString();
		store.writeState({
			...store.readState(),
			lastRuns: {
				"window:immediate": recentLastRun,
				"window:near": recentLastRun,
			},
		});
		const matchingRss = new RssSignal(cfg, {
			fetchImpl: (async () =>
				new Response(
					"<rss><channel><item><title>バンコク直行セール開催</title><link>https://example.com/a</link><guid>i3-guid-1</guid></item></channel></rss>",
				)) as unknown as typeof fetch,
		});
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [mockSweep, mockVerify] as never,
			rss: matchingRss,
		});
		expect(r.jobsRun).toContain("window:immediate");
		expect(r.jobsRun).toContain("window:near");
		expect(r.observations).toBeGreaterThan(0);
		const lastRuns = store.readState().lastRuns;
		expect(lastRuns["window:immediate"]).toBe(now.toISOString());
		expect(lastRuns["window:near"]).toBe(now.toISOString());
	});

	test("health: OKリセット後の新しい6連続失敗はlastAlertedAtで判定し警告する(I4)", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const sixWindows = Array.from({ length: 6 }, (_, i) => ({
			name: `w${i}`,
			from: 0,
			to: 1,
			every_minutes: 30,
		}));
		const cfg6 = { ...cfg, windows: sixWindows };
		// 早い時間帯に失敗streakがあり、その後OKでconsecutiveFailuresが0にリセットされた
		// 状態(=旧実装がlastErrorAt=today "だけ"を見て誤って抑制してしまう状態)。
		// lastAlertedAtは無し(=今日はまだ一度も警告embedを積んでいない)。
		store.writeHealth({
			boom: {
				lastErrorAt: new Date(now.getTime() - 3600e3).toISOString(),
				lastOkAt: new Date(now.getTime() - 1800e3).toISOString(),
				consecutiveFailures: 0,
			},
		});
		const boom = {
			name: "boom",
			available: () => true,
			sweep: async () => {
				throw new Error("still down");
			},
		};
		const sent: object[][] = [];
		const notifier = {
			send: async (embeds: object[]) => {
				sent.push(embeds);
			},
		};
		const r = await runWatchOnce({
			cfg: cfg6,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [boom] as never,
			rss: rssEmpty,
			notifier: notifier as never,
		});
		expect(r.errors.length).toBe(6);
		const allSent = sent.flat() as { title?: string }[];
		expect(
			allSent.some((e) => String(e.title).includes("boom が不調です")),
		).toBe(true);
		const health = store.readHealth();
		expect(health.boom?.consecutiveFailures).toBe(6);
		expect(health.boom?.lastAlertedAt).toBeDefined();
	});

	test("health: HttpError由来のlastErrorはredactUrl(根本対策)で秘密が伏せられている", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const secretUrl =
			"https://serpapi.com/search.json?engine=google_flights&api_key=SUPERSECRET123";
		const boom = {
			name: "boom",
			available: () => true,
			sweep: async () => {
				throw new HttpError(401, secretUrl, "unauthorized");
			},
		};
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [boom] as never,
			rss: rssEmpty,
		});
		expect(r.errors.length).toBeGreaterThan(0);
		expect(r.errors.some((e) => e.includes("SUPERSECRET123"))).toBe(false);
		const health = store.readHealth();
		expect(health.boom?.lastError).toBeDefined();
		expect(health.boom?.lastError).not.toContain("SUPERSECRET123");
		expect(health.boom?.lastError).toContain("***");
	});

	test("notifier未指定(非dryRun)ではappendNotifiedされない(I6)", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		const r = await runWatchOnce({
			cfg,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [mockSweep, mockVerify] as never,
			rss: rssEmpty,
			// notifier未指定(undefined)、dryRunも未指定(false)
		});
		expect(r.notified).toBe(1); // 「通知され得た」件数は返す
		expect(store.readNotified()).toEqual({});
		// 永続化そのもの(deals/state)はdryRunではないので行われる。
		expect(store.readDeals().length).toBeGreaterThan(0);
	});

	test("appendFaresはnotify_max*2を超える観測を永続化しない(spec 6.12)", async () => {
		const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
		// 窓を1つだけにして掃引呼び出しを1回に固定する(既定cfgのimmediate+near両方が
		// 常にdueな新規storeでは、掃引ソースが窓ごとに1回=2回呼ばれ観測数が倍になるため)。
		const cfg1 = {
			...cfg,
			windows: [{ name: "only", from: 0, to: 1, every_minutes: 30 }],
		};
		const cheap: FareObservation = {
			...cheapObs,
			id: "flt-cheap",
			priceJpy: 14000,
		};
		const expensive: FareObservation = {
			...cheapObs,
			id: "flt-expensive",
			priceJpy: 40000,
		};
		const twoObsSweep = {
			name: "mock-sweep-2",
			available: () => true,
			sweep: async () => [cheap, expensive],
		};
		const r = await runWatchOnce({
			cfg: cfg1,
			store,
			env: { isCI: true, hasBrowser: false, now },
			sources: [twoObsSweep] as never,
			rss: rssEmpty,
		});
		// フィルタは永続化のみ: このrunのcombine()には両方渡っている。
		expect(r.observations).toBe(2);
		const persisted = store.readRecentFares(48, now);
		expect(persisted.map((o) => o.id)).toEqual(["flt-cheap"]);
	});
});

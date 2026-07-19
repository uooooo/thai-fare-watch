import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { matchSaleNews, RssSignal } from "../src/signals/rss";

const cfg = loadConfig({ env: {} });
const xml = await Bun.file("test/fixtures/traicy-sale.xml").text();

describe("matchSaleNews", () => {
	test("タイ地名でマッチ", () => {
		expect(
			matchSaleNews(
				"エアアジア、日本〜バンコク線含む国際線でセール",
				cfg.rss_keywords,
			),
		).toContain("バンコク");
	});
	test("航空会社名のみ（国際文脈なし・国内線）は不一致", () => {
		expect(
			matchSaleNews(
				"ジェットスター、国内線全路線でセール 片道1,990円から",
				cfg.rss_keywords,
			),
		).toEqual([]);
	});
});

describe("RssSignal.poll", () => {
	const feed = {
		name: "traicy-sale",
		url: "https://x/feed",
		every_minutes: 60,
	};
	const f = (async () => new Response(xml)) as unknown as typeof fetch;
	test("新規マッチのみ返し、既読guidは返さない", async () => {
		const sig = new RssSignal(cfg, { fetchImpl: f });
		const r1 = await sig.poll(feed, []);
		expect(r1.news.map((n) => n.guid)).toEqual([
			"https://www.traicy.com/?p=1001",
			"https://www.traicy.com/?p=1003",
		]);
		const r2 = await sig.poll(feed, r1.seen);
		expect(r2.news).toEqual([]);
	});
});

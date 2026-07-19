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
	test("「タイムセール」単体は「タイ」に誤マッチしない", () => {
		expect(
			matchSaleNews("国内線タイムセール開催のお知らせ", cfg.rss_keywords),
		).toEqual([]);
		expect(
			matchSaleNews("春の国内線タイムセール開催", cfg.rss_keywords),
		).toEqual([]);
		expect(
			matchSaleNews("タイミングを合わせて予約しよう", cfg.rss_keywords),
		).toEqual([]);
	});
	test("「タイ」は境界があれば地名としてマッチする", () => {
		expect(
			matchSaleNews("エアアジア、タイ行きセール", cfg.rss_keywords),
		).toContain("タイ");
		expect(matchSaleNews("日本=タイ線が値下げ", cfg.rss_keywords)).toContain(
			"タイ",
		);
		expect(matchSaleNews("タイ・バンコク特集", cfg.rss_keywords)).toContain(
			"タイ",
		);
		expect(matchSaleNews("成田からタイへ", cfg.rss_keywords)).toContain("タイ");
	});
	test("長いカタカナ語は従来どおり部分一致（バンコクツアー等）", () => {
		expect(matchSaleNews("バンコクツアーが安い", cfg.rss_keywords)).toContain(
			"バンコク",
		);
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

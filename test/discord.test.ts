import { describe, expect, test } from "bun:test";
import {
	buildDealEmbed,
	buildHealthEmbed,
	buildNewsEmbed,
	DiscordNotifier,
} from "../src/notify/discord";
import type {
	GroundLeg,
	Itinerary,
	SaleNews,
	SellerOffer,
	SourceHealth,
} from "../src/types";
import { HttpError } from "../src/util/http";

const it: Itinerary = {
	id: "i1",
	kind: "self_transfer",
	totalJpy: 12220,
	fxFeeJpy: 220,
	risks: ["自己乗継(別切り)", "時刻要確認"],
	verification: "verified",
	tier: "deal",
	legs: [
		{
			id: "l1",
			source: "fli",
			origin: "NRT",
			destination: "ICN",
			departDate: "2026-08-02",
			departAt: "2026-08-02T08:00",
			airline: "Jin Air",
			flightNumber: "LJ 202",
			transfers: 0,
			priceJpy: 5000,
			market: "jp",
			foundAt: "2026-07-18T00:00:00Z",
		},
		{
			id: "l2",
			source: "fli",
			origin: "ICN",
			destination: "BKK",
			departDate: "2026-08-02",
			departAt: "2026-08-02T16:00",
			airline: "t'way",
			flightNumber: "TW 101",
			transfers: 0,
			priceJpy: 7000,
			market: "kr",
			foundAt: "2026-07-18T00:00:00Z",
		},
	],
};

describe("buildDealEmbed", () => {
	test("タイトルに🔥と総額、本文に経路・リスク・検証状態", () => {
		const e = buildDealEmbed(it) as { title: string; description: string };
		expect(e.title).toContain("🔥");
		expect(e.title).toContain("12,220");
		expect(e.description).toContain("NRT → ICN → BKK");
		expect(e.description).toContain("自己乗継");
		expect(e.description).toContain("verified");
	});

	test("tierごとに絵文字と色が変わる(flash/candidate/未定義→ℹ️)", () => {
		const flash = buildDealEmbed({ ...it, tier: "flash" }) as {
			title: string;
			color: number;
		};
		expect(flash.title).toContain("💥");
		expect(flash.color).toBe(0xff2d55);

		const candidate = buildDealEmbed({ ...it, tier: "candidate" }) as {
			title: string;
			color: number;
		};
		expect(candidate.title).toContain("⚠️");
		expect(candidate.color).toBe(0x8e8e93);

		const noTier = buildDealEmbed({ ...it, tier: undefined }) as {
			title: string;
			color: number;
		};
		expect(noTier.title).toContain("ℹ️");
		expect(noTier.color).toBe(0x0a84ff);
	});

	test("fxFeeJpyが0なら手数料行を出さない／正なら出す", () => {
		const noFee = buildDealEmbed({ ...it, fxFeeJpy: 0 }) as {
			description: string;
		};
		expect(noFee.description).not.toContain("外貨手数料");

		const withFee = buildDealEmbed(it) as { description: string };
		expect(withFee.description).toContain("外貨手数料込み: +¥220");
	});

	test("groundレグは経路サマリ先頭に「(モード)from→to」、内訳は「モード from→to ¥価格」", () => {
		const groundLeg: GroundLeg = {
			kind: "ground",
			mode: "bus",
			from: "TYO",
			to: "OSA",
			priceJpy: 6000,
			hours: 9,
		};
		const positioned: Itinerary = {
			id: "i2",
			kind: "positioned",
			totalJpy: 11000,
			fxFeeJpy: 0,
			risks: [],
			verification: "unverified",
			tier: "candidate",
			legs: [
				groundLeg,
				{
					id: "l3",
					source: "fli",
					origin: "OSA",
					destination: "BKK",
					departDate: "2026-08-05",
					airline: "Thai AirAsia",
					flightNumber: "FD1",
					transfers: 0,
					priceJpy: 5000,
					market: "jp",
					foundAt: "2026-07-18T00:00:00Z",
				},
			],
		};
		const e = buildDealEmbed(positioned) as {
			title: string;
			description: string;
		};
		expect(e.title).toContain("(バス)TYO→OSA");
		expect(e.description).toContain("バス TYO→OSA ¥6,000");
	});

	test("opts.sellerとopts.gfUrlの行を付与する", () => {
		const seller: SellerOffer = {
			seller: "Trip.com",
			isAirlineDirect: false,
			trust: "trusted_ota",
			priceJpy: 12000,
			bookingUrl: "https://trip.example/book",
		};
		const e = buildDealEmbed(it, {
			seller,
			gfUrl: "https://www.google.com/travel/flights/xyz",
		}) as { description: string };
		expect(e.description).toContain("予約先: Trip.com");
		expect(e.description).toContain("https://trip.example/book");
		expect(e.description).toContain(
			"Google Flights: https://www.google.com/travel/flights/xyz",
		);
	});
});

describe("buildNewsEmbed", () => {
	test("タイトル・url・色、descriptionにキーワードとフィード名", () => {
		const news: SaleNews = {
			guid: "g1",
			feed: "traicy-sale",
			title: "エアアジア、バンコク線セール",
			url: "https://example.com/news/1",
			matchedKeywords: ["バンコク"],
			publishedAt: "2026-07-18T00:00:00Z",
		};
		const e = buildNewsEmbed(news) as {
			title: string;
			url: string;
			description: string;
			color: number;
		};
		expect(e.title).toBe("ℹ️ セール速報: エアアジア、バンコク線セール");
		expect(e.url).toBe("https://example.com/news/1");
		expect(e.description).toContain("バンコク");
		expect(e.description).toContain("traicy-sale");
		expect(e.color).toBe(0x0a84ff);
	});
});

describe("buildHealthEmbed", () => {
	test("タイトル・色、descriptionにlastErrorと連続失敗回数", () => {
		const h: SourceHealth = {
			lastErrorAt: "2026-07-18T00:00:00Z",
			lastError: "HTTP 500 for https://fli",
			consecutiveFailures: 4,
		};
		const e = buildHealthEmbed("fli", h) as {
			title: string;
			description: string;
			color: number;
		};
		expect(e.title).toBe("🩺 fli が不調です");
		expect(e.description).toContain("HTTP 500 for https://fli");
		expect(e.description).toContain("4");
		expect(e.color).toBe(0xffcc00);
	});
});

describe("DiscordNotifier", () => {
	test("webhookへPOSTし、11embedは2回に分割", async () => {
		const calls: string[] = [];
		const f = (async (_u: string | URL, init?: RequestInit) => {
			calls.push(String(init?.body));
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		const n = new DiscordNotifier("https://discord.example/wh", {
			fetchImpl: f,
		});
		await n.send(Array.from({ length: 11 }, (_, i) => ({ title: `e${i}` })));
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[0]!).embeds).toHaveLength(10);
	});

	test("?wait=trueを付与しcontent-type: application/jsonでPOSTする", async () => {
		let capturedUrl = "";
		let capturedHeaders: RequestInit["headers"];
		const f = (async (u: string | URL, init?: RequestInit) => {
			capturedUrl = String(u);
			capturedHeaders = init?.headers;
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		const n = new DiscordNotifier("https://discord.example/wh", {
			fetchImpl: f,
		});
		await n.send([{ title: "e0" }]);
		expect(capturedUrl).toBe("https://discord.example/wh?wait=true");
		expect(new Headers(capturedHeaders).get("content-type")).toBe(
			"application/json",
		);
	});

	test("429などの一時失敗はリトライで自動復帰する", async () => {
		let calls = 0;
		const f = (async () => {
			calls++;
			if (calls === 1) return new Response("slow down", { status: 429 });
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		const n = new DiscordNotifier("https://discord.example/wh", {
			fetchImpl: f,
		});
		await n.send([{ title: "e0" }]);
		expect(calls).toBe(2);
	});

	test("非リトライ対象のステータス(400)は即throwする", async () => {
		let calls = 0;
		const f = (async () => {
			calls++;
			return new Response("bad request", { status: 400 });
		}) as unknown as typeof fetch;
		const n = new DiscordNotifier("https://discord.example/wh", {
			fetchImpl: f,
		});
		await expect(n.send([{ title: "e0" }])).rejects.toBeInstanceOf(HttpError);
		expect(calls).toBe(1);
	});
});

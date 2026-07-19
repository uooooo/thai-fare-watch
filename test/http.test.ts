import { describe, expect, test } from "bun:test";
import { fetchJson, HttpError, redactUrl } from "../src/util/http";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function seq(responses: Array<() => Response>): typeof fetch {
	let i = 0;
	return (async () => {
		const make = responses[Math.min(i++, responses.length - 1)];
		if (!make) throw new Error("seq: no responses given");
		return make();
	}) as unknown as typeof fetch;
}

describe("fetchJson", () => {
	test("200でJSONを返す", async () => {
		const f = seq([() => jsonResponse({ ok: 1 })]);
		expect(
			await fetchJson<{ ok: number }>("https://x/", { fetchImpl: f }),
		).toEqual({ ok: 1 });
	});
	test("429→200はリトライで成功", async () => {
		const f = seq([
			() => new Response("slow down", { status: 429 }),
			() => jsonResponse({ ok: 2 }),
		]);
		expect(
			await fetchJson<{ ok: number }>("https://x/", {
				fetchImpl: f,
				retries: 2,
			}),
		).toEqual({ ok: 2 });
	});
	test("リトライ上限まで429が続けばHttpErrorで打ち切る", async () => {
		let calls = 0;
		const f = (async () => {
			calls++;
			return new Response("slow down", { status: 429 });
		}) as unknown as typeof fetch;
		await expect(
			fetchJson("https://x/", { fetchImpl: f, retries: 1 }),
		).rejects.toBeInstanceOf(HttpError);
		expect(calls).toBe(2); // 初回 + リトライ1回で枯渇
	});
	test("404は即HttpError（リトライしない）", async () => {
		let calls = 0;
		const f = (async () => {
			calls++;
			return new Response("nf", { status: 404 });
		}) as unknown as typeof fetch;
		await expect(
			fetchJson("https://x/", { fetchImpl: f }),
		).rejects.toBeInstanceOf(HttpError);
		expect(calls).toBe(1);
	});
	test("秘密を含むURLでも失敗時のHttpError.messageに秘密は残らない(fetchWithRetry経由)", async () => {
		const f = (async () =>
			new Response("nf", { status: 404 })) as unknown as typeof fetch;
		const url = "https://serpapi.com/search.json?api_key=LEAKEDVIAFETCH";
		try {
			await fetchJson(url, { fetchImpl: f });
			throw new Error("expected fetchJson to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(HttpError);
			const message = (err as HttpError).message;
			expect(message).not.toContain("LEAKEDVIAFETCH");
			expect(message).toContain("***");
		}
	});
});

describe("redactUrl", () => {
	test("SerpAPI風のapi_keyクエリ値を伏せる", () => {
		const raw =
			"https://serpapi.com/search.json?engine=google_flights&api_key=SUPERSECRET";
		const out = redactUrl(raw);
		expect(out).not.toContain("SUPERSECRET");
		expect(out).toContain("api_key=***");
	});
	test("Travelpayouts風のtokenクエリ値を伏せる", () => {
		const raw =
			"https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=TYO&token=TPSECRETVALUE";
		const out = redactUrl(raw);
		expect(out).not.toContain("TPSECRETVALUE");
		expect(out).toContain("token=***");
	});
	test("Discord webhookはURL全体が秘密—パス中のトークンを伏せる", () => {
		const raw =
			"https://discord.com/api/webhooks/123456789/WEBHOOKSECRET?wait=true";
		const out = redactUrl(raw);
		expect(out).not.toContain("WEBHOOKSECRET");
		expect(out).toContain("/api/webhooks/123456789/***");
		expect(out).toContain("wait=true"); // 秘密ではない部分は保持する
	});
	test("秘密パラメータが無いURLはそのまま返す(過剰マスクしない)", () => {
		const raw = "https://example.com/search?q=bangkok&page=2";
		expect(redactUrl(raw)).toBe(raw);
	});
	test("new URL()がパース失敗する入力でも例外を投げず秘密を伏せて返す(fallback)", () => {
		const raw = "not-a-valid-url?api_key=STILLSECRET";
		const out = redactUrl(raw);
		expect(out).not.toContain("STILLSECRET");
	});
});

describe("HttpError", () => {
	test("SerpAPI風URLのapi_keyは.message/.urlどちらにも残らない", () => {
		const url =
			"https://serpapi.com/search.json?engine=google_flights&api_key=SUPERSECRET";
		const err = new HttpError(401, url);
		expect(err.message).not.toContain("SUPERSECRET");
		expect(err.url).not.toContain("SUPERSECRET");
		expect(err.message).toContain("***");
		expect(err.url).toContain("***");
	});
	test("Discord webhookのトークンは.message/.urlどちらにも残らない", () => {
		const url = "https://discord.com/api/webhooks/123/WEBHOOKSECRET?wait=true";
		const err = new HttpError(401, url);
		expect(err.message).not.toContain("WEBHOOKSECRET");
		expect(err.url).not.toContain("WEBHOOKSECRET");
	});
	test("bodyは.messageに含めない(秘密がbodyに載っていても漏れない)。.bodyフィールドには残す", () => {
		const err = new HttpError(
			500,
			"https://example.com/x",
			"leaked-secret-body",
		);
		expect(err.message).not.toContain("leaked-secret-body");
		expect(err.message).toBe("HTTP 500 for https://example.com/x");
		expect(err.body).toBe("leaked-secret-body");
	});
});

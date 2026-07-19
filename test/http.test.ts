import { describe, expect, test } from "bun:test";
import {
	fetchJson,
	HttpError,
	redactUrl,
	safeErrorMessage,
	scrubUrls,
} from "../src/util/http";

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

describe("scrubUrls", () => {
	test("地の文に埋め込まれた秘密付きURLを伏せる(prose内のURL)", () => {
		const text =
			"failed calling https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=TYO&token=PROSESECRET1 aborted after 3 retries";
		const out = scrubUrls(text);
		expect(out).not.toContain("PROSESECRET1");
		expect(out).toContain("***");
		expect(out).toContain("aborted after 3 retries"); // 秘密以外の地の文は保持
	});
	test("URLを含まない文字列はそのまま返す(過剰マスクしない)", () => {
		expect(scrubUrls("plain message, no url here")).toBe(
			"plain message, no url here",
		);
	});
});

describe("safeErrorMessage", () => {
	test("HttpErrorは.messageのみ(既にredact済み・bodyを含まない)を返す", () => {
		const err = new HttpError(
			500,
			"https://x.example/?token=HTTPERRSECRET1",
			"body-secret-HTTPERRSECRET2",
		);
		const out = safeErrorMessage(err);
		expect(out).toBe(err.message);
		expect(out).not.toContain("HTTPERRSECRET1");
		expect(out).not.toContain("HTTPERRSECRET2"); // body由来の秘密は最初から.messageに無い
	});
	test("秘密付きURLがmessageに直接埋め込まれた通常Errorはscrubされる", () => {
		const err = new Error(
			"fetch failed for https://api.travelpayouts.com/x?token=PLAINERRSECRET1",
		);
		const out = safeErrorMessage(err);
		expect(out).not.toContain("PLAINERRSECRET1");
		expect(out).toContain("***");
	});
	test(".pathに秘密URLがあっても.messageしか読まないため含まれない", () => {
		const err = new Error("Unable to connect");
		(err as unknown as { path: string }).path =
			"http://x/aviasales?token=PATHONLYSECRET1";
		const out = safeErrorMessage(err);
		expect(out).toBe("Unable to connect");
		expect(out).not.toContain("PATHONLYSECRET1");
	});
	test("Errorでない値も文字列化した上でscrubする", () => {
		expect(safeErrorMessage(42)).toBe("42");
		expect(
			safeErrorMessage("boom https://x.example/?token=NONERRSECRET1"),
		).not.toContain("NONERRSECRET1");
	});
});

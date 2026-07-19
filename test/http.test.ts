import { describe, expect, test } from "bun:test";
import { fetchJson, HttpError } from "../src/util/http";

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
});

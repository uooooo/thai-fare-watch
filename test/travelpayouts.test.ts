import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { TravelpayoutsSource } from "../src/sources/travelpayouts";
import fixture from "./fixtures/tp-prices-for-dates.json";

const cfg = loadConfig({ env: { TRAVELPAYOUTS_TOKEN: "tp-test" } });
const env = {
	isCI: true,
	hasBrowser: false,
	now: new Date("2026-07-18T00:00:00Z"),
};

// console.warnをスパイして実際に出力される全引数を捕捉する。console.warnは非文字列引数を
// Bun.inspect相当の展開で表示する(=Errorのenumerableプロパティも含めて丸ごと出す)ため、
// ここでも同様にBun.inspectでフォーマットしてから連結する — これで「実際にターミナル/stderrに
// 出る文字列」を再現でき、生Errorオブジェクトを渡した場合の漏洩を確実に検出できる。
function captureWarn(): { text: () => string; restore: () => void } {
	const calls: unknown[][] = [];
	const original = console.warn;
	console.warn = ((...args: unknown[]) => {
		calls.push(args);
	}) as typeof console.warn;
	return {
		text: () =>
			calls
				.map((args) =>
					args
						.map((a) => (typeof a === "string" ? a : Bun.inspect(a)))
						.join(" "),
				)
				.join("\n"),
		restore: () => {
			console.warn = original;
		},
	};
}

describe("TravelpayoutsSource", () => {
	test("tokenが無ければavailable=false", () => {
		const s = new TravelpayoutsSource(loadConfig({ env: {} }));
		expect(s.available(env)).toBe(false);
	});
	test("sweepはURLにtoken/market/currency/月を含め、FareObservationへ変換", async () => {
		const urls: string[] = [];
		const f = (async (u: string | URL | Request) => {
			urls.push(String(u));
			return Response.json(fixture);
		}) as unknown as typeof fetch;
		const s = new TravelpayoutsSource(cfg, {
			fetchImpl: f,
			sleep: async () => {},
		});
		const got = await s.sweep(
			[
				{ origin: "TYO", destination: "BKK", market: "jp" },
				{ origin: "SEL", destination: "BKK", market: "kr" },
			],
			{ from: "2026-08-01", to: "2026-08-31" },
		);
		expect(urls[0]).toContain("origin=TYO");
		expect(urls[0]).toContain("market=jp");
		expect(urls[0]).toContain("currency=jpy");
		expect(urls[0]).toContain("departure_at=2026-08");
		expect(urls[0]).toContain("one_way=true");
		expect(urls[1]).toContain("market=kr");
		const o = got[0];
		if (!o) throw new Error("expected at least one observation");
		expect(o.source).toBe("travelpayouts");
		expect(o.priceJpy).toBe(14980);
		expect(o.departDate).toBe("2026-08-02");
		expect(o.departAt).toBe("2026-08-02T09:15:00+09:00");
		expect(o.market).toBe("jp");
		expect(o.expiresAt).toBeDefined();
		expect(o.id).toMatch(/^[0-9a-f]{12}$/);
	});
	test("範囲外の日付・successでない応答は捨てる", async () => {
		const f = (async () =>
			Response.json({
				success: true,
				data: fixture.data,
			})) as unknown as typeof fetch;
		const s = new TravelpayoutsSource(cfg, {
			fetchImpl: f,
			sleep: async () => {},
		});
		const got = await s.sweep(
			[{ origin: "TYO", destination: "BKK", market: "jp" }],
			{ from: "2026-08-03", to: "2026-08-31" },
		);
		expect(got.map((o) => o.departDate)).toEqual(["2026-08-05"]); // 08-02は範囲外
	});

	// --- セキュリティ修正(Task 14 fix report 2): 生Errorオブジェクトのログ経由の秘密漏洩 ---

	test("ネットワークエラー(.pathに秘密URL)でもconsole.warnの出力に秘密が出ない", async () => {
		// Bunのfetchはネットワーク層の失敗(接続拒否/DNS失敗等)でenumerableな.pathに
		// 生URL(秘密含む)を付与したErrorをthrowする。travelpayouts.comへの実接続で
		// 現実的に起こり得るケースを再現する。
		const f = (async () => {
			const e = new Error("Unable to connect");
			(e as unknown as { path: string }).path =
				"http://x/aviasales?token=NETWORKSECRET777";
			throw e;
		}) as unknown as typeof fetch;
		const s = new TravelpayoutsSource(cfg, {
			fetchImpl: f,
			sleep: async () => {},
		});
		const warn = captureWarn();
		try {
			// 全滅時の集約throwはこのテストの関心外(console.warn出力のみ検証する)。
			await s
				.sweep([{ origin: "TYO", destination: "BKK", market: "jp" }], {
					from: "2026-08-01",
					to: "2026-08-31",
				})
				.catch(() => {});
		} finally {
			warn.restore();
		}
		expect(warn.text()).not.toContain("NETWORKSECRET777");
	});

	test("HttpError(400+秘密クエリURL+秘密混入body)でもconsole.warnの出力に秘密が出ない", async () => {
		const localCfg = loadConfig({
			env: { TRAVELPAYOUTS_TOKEN: "URLQSECRET1" },
		});
		const f = (async () =>
			new Response("invalid token: BODYSECRET1", {
				status: 400,
			})) as unknown as typeof fetch;
		const s = new TravelpayoutsSource(localCfg, {
			fetchImpl: f,
			sleep: async () => {},
		});
		const warn = captureWarn();
		try {
			await s
				.sweep([{ origin: "TYO", destination: "BKK", market: "jp" }], {
					from: "2026-08-01",
					to: "2026-08-31",
				})
				.catch(() => {});
		} finally {
			warn.restore();
		}
		const text = warn.text();
		expect(text).not.toContain("URLQSECRET1"); // urlの秘密(redactUrl経由で既に***化)
		expect(text).not.toContain("BODYSECRET1"); // bodyの秘密(そもそも.messageに含まれない)
	});
});

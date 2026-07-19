import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store";
import type { FareObservation, Itinerary } from "../src/types";
import { todayJst } from "../src/util/dates";

async function run(args: string[], env: Record<string, string> = {}) {
	const p = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
		env: {
			...process.env,
			TFW_DATA_DIR: mkdtempSync(join(tmpdir(), "tfw-")),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout, stderr, exitCode };
}

// fli/travelpayouts/serpapiを全て無効化し、rss_feedsも空にした構成。外部API/ネットワークに
// 一切触れないため、watch/sweep/verifyの「能力ゼロ」経路もサブプロセスE2Eで安全に検証できる。
const NO_SOURCES_CONFIG = "test/fixtures/cli-no-sources.toml";
const noCredsEnv = { TRAVELPAYOUTS_TOKEN: "", SERPAPI_API_KEY: "" };

describe("tfw CLI", () => {
	test("config --json は秘密をマスクして出力", async () => {
		const r = await run(["config", "--json"], {
			TRAVELPAYOUTS_TOKEN: "tp-secret",
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).not.toContain("tp-secret");
		expect(JSON.parse(r.stdout).thresholds.notify_max).toBe(15000);
	});
	test("deals --json は空配列で正常終了", async () => {
		const r = await run(["deals", "--json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ deals: [] });
	});
	test("notify-test はwebhook未設定なら終了コード1とエラーメッセージ", async () => {
		const r = await run(["notify-test"], { DISCORD_WEBHOOK_URL: "" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("DISCORD_WEBHOOK_URL");
	});
	test("quota --json はキー未設定を明示", async () => {
		const r = await run(["quota", "--json"], { SERPAPI_API_KEY: "" });
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout).enabled).toBe(false);
	});

	// --- 以下、brief記載の4テストに加えて追加した回帰テスト（すべて外部APIに触れない） ---

	test("setup-localはTask 16未実装のプレースホルダとして終了コード1", async () => {
		const r = await run(["setup-local"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Task 16");
	});

	test("newsはstateが本文を保持しないため常に空配列", async () => {
		const r = await run(["news", "--json"]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ news: [] });
	});

	test("deals --json は既存のdeals.jsonをそのまま返す", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const deal: Itinerary = {
			id: "d1",
			kind: "direct",
			legs: [],
			totalJpy: 12000,
			fxFeeJpy: 0,
			risks: [],
			verification: "unverified",
		};
		new Store(dir).writeDeals([deal]);
		const r = await run(["deals", "--json"], { TFW_DATA_DIR: dir });
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ deals: [deal] });
	});

	test("history FROM TOは日毎最安値を日付昇順で集計し他ルートは除外する", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		const store = new Store(dir);
		const now = new Date();
		const mk = (over: Partial<FareObservation>): FareObservation => ({
			id: "x",
			source: "travelpayouts",
			origin: "TYO",
			destination: "BKK",
			departDate: "2026-08-02",
			transfers: 0,
			priceJpy: 14000,
			market: "jp",
			foundAt: now.toISOString(),
			...over,
		});
		store.appendFares([
			mk({ id: "a", departDate: "2026-08-02", priceJpy: 14000 }),
			mk({ id: "b", departDate: "2026-08-02", priceJpy: 12000 }),
			mk({ id: "c", departDate: "2026-08-05", priceJpy: 20000 }),
			mk({
				id: "d",
				departDate: "2026-08-01",
				destination: "CNX",
				priceJpy: 5000,
			}),
		]);
		const r = await run(["history", "TYO", "BKK", "--json"], {
			TFW_DATA_DIR: dir,
		});
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			history: [
				{ departDate: "2026-08-02", minPriceJpy: 12000 },
				{ departDate: "2026-08-05", minPriceJpy: 20000 },
			],
		});
	});

	test("quota --json はキー設定時にreadQuotaの値を反映する", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-"));
		new Store(dir).writeQuota({ month: todayJst().slice(0, 7), used: 42 });
		const r = await run(["quota", "--json"], {
			TFW_DATA_DIR: dir,
			SERPAPI_API_KEY: "serp-secret",
		});
		expect(r.exitCode).toBe(0);
		const parsed = JSON.parse(r.stdout);
		expect(parsed).toMatchObject({ enabled: true, used: 42 });
		expect(r.stdout).not.toContain("serp-secret");
	});

	test("verify: 価格ソースが無ければ明確なメッセージと終了コード1", async () => {
		const r = await run(
			["verify", "BKK", "HKT", "2026-08-02", "--config", NO_SOURCES_CONFIG],
			noCredsEnv,
		);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("verify");
	});

	test("sweep: 掃引可能なソースが無ければ空観測配列で正常終了", async () => {
		const r = await run(
			["sweep", "--json", "--config", NO_SOURCES_CONFIG],
			noCredsEnv,
		);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ observations: [] });
	});

	test("watch --onceはネットワーク不要な構成でエラー無しのRunResultを返す", async () => {
		const r = await run(
			["watch", "--once", "--dry-run", "--json", "--config", NO_SOURCES_CONFIG],
			noCredsEnv,
		);
		expect(r.exitCode).toBe(0);
		const result = JSON.parse(r.stdout);
		expect(result.errors).toEqual([]);
		expect(result.observations).toBe(0);
	});

	test("watch: --once省略時も1回実行し継続モード未実装のヒントをstderrに出す", async () => {
		const r = await run(
			["watch", "--dry-run", "--json", "--config", NO_SOURCES_CONFIG],
			noCredsEnv,
		);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout).errors).toEqual([]);
		expect(r.stderr.length).toBeGreaterThan(0);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, maskedConfig } from "../src/config";

describe("config", () => {
	test("リポジトリ既定のtfw.config.tomlが読める", () => {
		const c = loadConfig({ env: {} });
		expect(c.hubs).toContain("SEL");
		expect(c.thresholds.notify_max).toBe(15000);
		expect(c.windows.map((w) => w.name)).toEqual(["immediate", "near"]);
		expect(c.ground.find((g) => g.to === "HND")?.priceJpy).toBe(600);
	});
	test("envから秘密を拾い、maskedConfigで漏らさない", () => {
		const c = loadConfig({
			env: {
				DISCORD_WEBHOOK_URL: "https://discord.example/x",
				TRAVELPAYOUTS_TOKEN: "tp-secret",
			},
		});
		expect(c.secrets.discordWebhookUrl).toBe("https://discord.example/x");
		const masked = JSON.stringify(maskedConfig(c));
		expect(masked).not.toContain("tp-secret");
		expect(masked).not.toContain("discord.example");
	});
	test("空文字envはundefined扱い（Actionsの未設定Secrets対策）", () => {
		const c = loadConfig({ env: { SERPAPI_API_KEY: "" } });
		expect(c.secrets.serpapiKey).toBeUndefined();
	});
	test("壊れた値はzodが弾く", () => {
		expect(() =>
			loadConfig({ path: "test/fixtures/bad-config.toml", env: {} }),
		).toThrow();
	});
	test("既定パス未指定でcwdに設定ファイルが無ければ既定値のみになる", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "tfw-config-"));
		const c = loadConfig({ cwd: emptyDir, env: {} });
		expect(c.thresholds.notify_max).toBe(15000);
		rmSync(emptyDir, { recursive: true, force: true });
	});
	test("cwdのtfw.config.tomlが実際に読まれる（既定値と異なる値で検証）", () => {
		const dir = mkdtempSync(join(tmpdir(), "tfw-config-"));
		writeFileSync(
			join(dir, "tfw.config.toml"),
			"[thresholds]\nnotify_max = 99999\n",
		);
		const c = loadConfig({ cwd: dir, env: {} });
		expect(c.thresholds.notify_max).toBe(99999);
		expect(c.thresholds.flash_max).toBe(10000);
		rmSync(dir, { recursive: true, force: true });
	});
	test("明示パスが存在しなければ例外を投げる", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "tfw-config-"));
		expect(() =>
			loadConfig({ path: join(emptyDir, "nope.toml"), env: {} }),
		).toThrow();
		rmSync(emptyDir, { recursive: true, force: true });
	});
	test("未知キーを含むTOMLはzodが弾く", () => {
		expect(() =>
			loadConfig({ path: "test/fixtures/unknown-key.toml", env: {} }),
		).toThrow();
	});
	// Task 15b: skyscannerセクションの既定値(TOML未指定でも存在すること)。
	// headless=falseがgf-browserのbrowser.headless=trueと非対称であることを含めて確認する
	// (Skyscannerは温めたheadfulの実チャネルを前提とするため既定を意図的に反転させている)。
	test("skyscanner既定値(未設定TOMLでも存在し、headless=falseがgf-browserと非対称)", () => {
		const c = loadConfig({ env: {} });
		expect(c.skyscanner).toEqual({
			enabled: true,
			headless: false,
			user_data_dir: "",
			market: "jp",
			cooldown_hours: 6,
			// 既定false: 実DOMで隔離バッジ要素を検証するまでバッジ信頼付与は無効。
			trust_recommended_badge: false,
		});
		expect(c.skyscanner.headless).not.toBe(c.browser.headless);
	});
	test("thresholdsを一部だけ指定すると残りは既定値にフォールバックする", () => {
		const c = loadConfig({
			path: "test/fixtures/partial-thresholds.toml",
			env: {},
		});
		expect(c.thresholds.notify_max).toBe(12000);
		expect(c.thresholds.flash_max).toBe(10000);
		expect(c.thresholds.watch_margin).toBe(1.2);
		expect(c.windows.map((w) => w.name)).toEqual(["immediate", "near"]);
	});
});

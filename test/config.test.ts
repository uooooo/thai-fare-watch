import { describe, expect, test } from "bun:test";
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
});

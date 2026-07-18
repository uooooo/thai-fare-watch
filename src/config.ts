import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import type { GroundLeg } from "./types";

const DEFAULT_CONFIG_PATH = "tfw.config.toml";

export type WindowConf = {
	name: string;
	from: number;
	to: number;
	every_minutes: number;
};
export type FeedConf = { name: string; url: string; every_minutes: number };
export type GroundConf = {
	to: string;
	mode: GroundLeg["mode"];
	priceJpy: number;
	hours: number;
};
export type Config = {
	origins: string[];
	positioning: string[];
	hubs: string[];
	destinations: string[];
	thresholds: { notify_max: number; flash_max: number; watch_margin: number };
	windows: WindowConf[];
	trusted_otas: string[];
	fx_fee_rate: number;
	combine: {
		min_connect_hours: number;
		max_connect_hours: number;
		allow_next_day: boolean;
		max_total_hours: number;
	};
	browser: {
		enabled: "auto" | boolean;
		min_interval_sec: number;
		jitter_sec: number;
		deep_sweep_every_hours: number;
		headless: boolean;
		channel: string;
	};
	fli: {
		enabled: boolean;
		ci_circuit_breaker: {
			consecutive_failures: number;
			cooldown_hours: number;
		};
	};
	serpapi: { monthly_quota: number; daily_budget_cap: number };
	rss_feeds: FeedConf[];
	rss_keywords: { places: string[]; airlines: string[]; context: string[] };
	ground: GroundConf[];
	secrets: {
		discordWebhookUrl?: string;
		travelpayoutsToken?: string;
		serpapiKey?: string;
	};
};

const windowConfSchema = z.strictObject({
	name: z.string(),
	from: z.number(),
	to: z.number(),
	every_minutes: z.number(),
});

const feedConfSchema = z.strictObject({
	name: z.string(),
	url: z.string(),
	every_minutes: z.number(),
});

const groundConfSchema = z.strictObject({
	to: z.string(),
	mode: z.enum(["train", "bus"]),
	priceJpy: z.number(),
	hours: z.number(),
});

const configSchema = z.strictObject({
	origins: z.array(z.string()).default(["TYO"]),
	positioning: z.array(z.string()).default(["OSA", "NGO", "FUK", "OKA"]),
	hubs: z
		.array(z.string())
		.default(["SEL", "TPE", "KUL", "SGN", "SIN", "HKG", "MNL"]),
	destinations: z.array(z.string()).default(["BKK", "CNX", "HKT"]),
	thresholds: z
		.strictObject({
			notify_max: z.number().default(15000),
			flash_max: z.number().default(10000),
			watch_margin: z.number().default(1.2),
		})
		.default({ notify_max: 15000, flash_max: 10000, watch_margin: 1.2 }),
	windows: z.array(windowConfSchema).default([
		{ name: "immediate", from: 0, to: 1, every_minutes: 30 },
		{ name: "near", from: 2, to: 31, every_minutes: 60 },
	]),
	trusted_otas: z.array(z.string()).default(["trip.com", "booking.com"]),
	fx_fee_rate: z.number().default(0.022),
	combine: z
		.strictObject({
			min_connect_hours: z.number().default(4),
			max_connect_hours: z.number().default(26),
			allow_next_day: z.boolean().default(true),
			max_total_hours: z.number().default(40),
		})
		.default({
			min_connect_hours: 4,
			max_connect_hours: 26,
			allow_next_day: true,
			max_total_hours: 40,
		}),
	browser: z
		.strictObject({
			enabled: z.union([z.literal("auto"), z.boolean()]).default("auto"),
			min_interval_sec: z.number().default(45),
			jitter_sec: z.number().default(20),
			deep_sweep_every_hours: z.number().default(3),
			headless: z.boolean().default(true),
			channel: z.string().default("chrome"),
		})
		.default({
			enabled: "auto",
			min_interval_sec: 45,
			jitter_sec: 20,
			deep_sweep_every_hours: 3,
			headless: true,
			channel: "chrome",
		}),
	fli: z
		.strictObject({
			enabled: z.boolean().default(true),
			ci_circuit_breaker: z
				.strictObject({
					consecutive_failures: z.number().default(3),
					cooldown_hours: z.number().default(6),
				})
				.default({ consecutive_failures: 3, cooldown_hours: 6 }),
		})
		.default({
			enabled: true,
			ci_circuit_breaker: { consecutive_failures: 3, cooldown_hours: 6 },
		}),
	serpapi: z
		.strictObject({
			monthly_quota: z.number().default(250),
			daily_budget_cap: z.number().default(8),
		})
		.default({ monthly_quota: 250, daily_budget_cap: 8 }),
	rss_feeds: z.array(feedConfSchema).default([
		{
			name: "traicy-sale",
			url: "https://www.traicy.com/category/airline/sale/feed",
			every_minutes: 60,
		},
		{
			name: "sky-budget",
			url: "https://sky-budget.com/feed/",
			every_minutes: 120,
		},
	]),
	rss_keywords: z
		.strictObject({
			places: z
				.array(z.string())
				.default([
					"タイ",
					"バンコク",
					"プーケット",
					"チェンマイ",
					"ドンムアン",
					"スワンナプーム",
				]),
			airlines: z
				.array(z.string())
				.default([
					"エアアジア",
					"ZIPAIR",
					"ジップエア",
					"スクート",
					"ベトジェット",
					"ピーチ",
					"ジェットスター",
					"タイ・ライオン・エア",
					"AirAsia",
					"Scoot",
					"VietJet",
					"Peach",
				]),
			context: z
				.array(z.string())
				.default(["セール", "アジア", "国際線", "タイムセール", "片道"]),
		})
		.default({
			places: [
				"タイ",
				"バンコク",
				"プーケット",
				"チェンマイ",
				"ドンムアン",
				"スワンナプーム",
			],
			airlines: [
				"エアアジア",
				"ZIPAIR",
				"ジップエア",
				"スクート",
				"ベトジェット",
				"ピーチ",
				"ジェットスター",
				"タイ・ライオン・エア",
				"AirAsia",
				"Scoot",
				"VietJet",
				"Peach",
			],
			context: ["セール", "アジア", "国際線", "タイムセール", "片道"],
		}),
	ground: z.array(groundConfSchema).default([
		{ to: "NRT", mode: "bus", priceJpy: 1500, hours: 1.5 },
		{ to: "HND", mode: "train", priceJpy: 600, hours: 0.5 },
		{ to: "OSA", mode: "bus", priceJpy: 6000, hours: 9.0 },
		{ to: "NGO", mode: "bus", priceJpy: 4000, hours: 6.0 },
	]),
	secrets: z
		.strictObject({
			discordWebhookUrl: z.string().optional(),
			travelpayoutsToken: z.string().optional(),
			serpapiKey: z.string().optional(),
		})
		.default({}),
});

function readSecret(
	env: Record<string, string | undefined>,
	key: string,
): string | undefined {
	const v = env[key];
	return v === undefined || v === "" ? undefined : v;
}

// TOML本体を読む。既定パス(未指定)でファイルが無ければ既定値のみで動く({}を返す)。
// 明示パス指定時は読めなければ例外を伝播させる（握り潰さない）。
function readRawToml(path: string, explicitPath: boolean): unknown {
	if (!explicitPath && !existsSync(path)) return {};
	return parse(readFileSync(path, "utf8"));
}

export function loadConfig(opts?: {
	path?: string;
	env?: Record<string, string | undefined>;
}): Config {
	const path = opts?.path ?? DEFAULT_CONFIG_PATH;
	const raw = readRawToml(path, opts?.path !== undefined);
	const env = opts?.env ?? process.env;
	const rawWithSecrets = {
		...(raw as Record<string, unknown>),
		secrets: {
			discordWebhookUrl: readSecret(env, "DISCORD_WEBHOOK_URL"),
			travelpayoutsToken: readSecret(env, "TRAVELPAYOUTS_TOKEN"),
			serpapiKey: readSecret(env, "SERPAPI_API_KEY"),
		},
	};
	return configSchema.parse(rawWithSecrets);
}

export function maskedConfig(c: Config): unknown {
	const mask = (v: string | undefined) => (v === undefined ? undefined : "***");
	return {
		...c,
		secrets: {
			discordWebhookUrl: mask(c.secrets.discordWebhookUrl),
			travelpayoutsToken: mask(c.secrets.travelpayoutsToken),
			serpapiKey: mask(c.secrets.serpapiKey),
		},
	};
}

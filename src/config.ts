import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
	skyscanner: {
		enabled: boolean;
		headless: boolean;
		user_data_dir: string;
		market: string;
		cooldown_hours: number;
		trust_recommended_badge: boolean;
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

const THRESHOLDS_DEFAULTS: Config["thresholds"] = {
	notify_max: 15000,
	flash_max: 10000,
	watch_margin: 1.2,
};

const COMBINE_DEFAULTS: Config["combine"] = {
	min_connect_hours: 4,
	max_connect_hours: 26,
	allow_next_day: true,
	max_total_hours: 40,
};

const BROWSER_DEFAULTS: Config["browser"] = {
	enabled: "auto",
	min_interval_sec: 45,
	jitter_sec: 20,
	deep_sweep_every_hours: 3,
	headless: true,
	channel: "chrome",
};

const FLI_CIRCUIT_BREAKER_DEFAULTS: Config["fli"]["ci_circuit_breaker"] = {
	consecutive_failures: 3,
	cooldown_hours: 6,
};

const FLI_DEFAULTS: Config["fli"] = {
	enabled: true,
	ci_circuit_breaker: FLI_CIRCUIT_BREAKER_DEFAULTS,
};

// headlessは既定false —Skyscanner(PerimeterX+TLSフィンガープリンティング)は素の
// headless自動化を高確度で検出/ブロックするため、実チャネル(channel:"chrome")の
// 「温めた」永続プロファイル+headfulの組が最も通りやすい想定(gf-browserのheadless
// 既定trueとは対照的)。user_data_dirは既定""(=空)で、実際の解決(リポジトリ配下の
// .skyscanner-profile/へのフォールバック)はsrc/sources/skyscanner/index.tsの
// 遅延importされたdefaultLaunchPersistent内で行う(config.ts自体はプロファイルの
// 実パス解決に関与しない)。
const SKYSCANNER_DEFAULTS: Config["skyscanner"] = {
	enabled: true,
	headless: false,
	user_data_dir: "",
	market: "jp",
	cooldown_hours: 6,
	// バッジによる信頼付与は既定で無効。実DOMで「隔離されたバッジ要素」のセレクタを
	// 検証できるまでtrueにしない(現状Skyscannerはbot対策でブロックされ実採取できていない)。
	// 将来warmupプロファイルで実採取・検証してからtrueに切り替える。
	trust_recommended_badge: false,
};

const SERPAPI_DEFAULTS: Config["serpapi"] = {
	monthly_quota: 250,
	daily_budget_cap: 8,
};

const RSS_KEYWORDS_DEFAULTS: Config["rss_keywords"] = {
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
};

const configSchema = z.strictObject({
	origins: z.array(z.string()).default(["TYO"]),
	positioning: z.array(z.string()).default(["OSA", "NGO", "FUK", "OKA"]),
	hubs: z
		.array(z.string())
		.default(["SEL", "TPE", "KUL", "SGN", "SIN", "HKG", "MNL"]),
	destinations: z.array(z.string()).default(["BKK", "CNX", "HKT"]),
	thresholds: z
		.strictObject({
			notify_max: z.number().default(THRESHOLDS_DEFAULTS.notify_max),
			flash_max: z.number().default(THRESHOLDS_DEFAULTS.flash_max),
			watch_margin: z.number().default(THRESHOLDS_DEFAULTS.watch_margin),
		})
		.default(THRESHOLDS_DEFAULTS),
	windows: z.array(windowConfSchema).default([
		{ name: "immediate", from: 0, to: 1, every_minutes: 30 },
		{ name: "near", from: 2, to: 31, every_minutes: 60 },
	]),
	trusted_otas: z.array(z.string()).default(["trip.com", "booking.com"]),
	fx_fee_rate: z.number().default(0.022),
	combine: z
		.strictObject({
			min_connect_hours: z.number().default(COMBINE_DEFAULTS.min_connect_hours),
			max_connect_hours: z.number().default(COMBINE_DEFAULTS.max_connect_hours),
			allow_next_day: z.boolean().default(COMBINE_DEFAULTS.allow_next_day),
			max_total_hours: z.number().default(COMBINE_DEFAULTS.max_total_hours),
		})
		.default(COMBINE_DEFAULTS),
	browser: z
		.strictObject({
			enabled: z
				.union([z.literal("auto"), z.boolean()])
				.default(BROWSER_DEFAULTS.enabled),
			min_interval_sec: z.number().default(BROWSER_DEFAULTS.min_interval_sec),
			jitter_sec: z.number().default(BROWSER_DEFAULTS.jitter_sec),
			deep_sweep_every_hours: z
				.number()
				.default(BROWSER_DEFAULTS.deep_sweep_every_hours),
			headless: z.boolean().default(BROWSER_DEFAULTS.headless),
			channel: z.string().default(BROWSER_DEFAULTS.channel),
		})
		.default(BROWSER_DEFAULTS),
	fli: z
		.strictObject({
			enabled: z.boolean().default(FLI_DEFAULTS.enabled),
			ci_circuit_breaker: z
				.strictObject({
					consecutive_failures: z
						.number()
						.default(FLI_CIRCUIT_BREAKER_DEFAULTS.consecutive_failures),
					cooldown_hours: z
						.number()
						.default(FLI_CIRCUIT_BREAKER_DEFAULTS.cooldown_hours),
				})
				.default(FLI_CIRCUIT_BREAKER_DEFAULTS),
		})
		.default(FLI_DEFAULTS),
	skyscanner: z
		.strictObject({
			enabled: z.boolean().default(SKYSCANNER_DEFAULTS.enabled),
			headless: z.boolean().default(SKYSCANNER_DEFAULTS.headless),
			user_data_dir: z.string().default(SKYSCANNER_DEFAULTS.user_data_dir),
			market: z.string().default(SKYSCANNER_DEFAULTS.market),
			cooldown_hours: z.number().default(SKYSCANNER_DEFAULTS.cooldown_hours),
			trust_recommended_badge: z
				.boolean()
				.default(SKYSCANNER_DEFAULTS.trust_recommended_badge),
		})
		.default(SKYSCANNER_DEFAULTS),
	serpapi: z
		.strictObject({
			monthly_quota: z.number().default(SERPAPI_DEFAULTS.monthly_quota),
			daily_budget_cap: z.number().default(SERPAPI_DEFAULTS.daily_budget_cap),
		})
		.default(SERPAPI_DEFAULTS),
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
			places: z.array(z.string()).default(RSS_KEYWORDS_DEFAULTS.places),
			airlines: z.array(z.string()).default(RSS_KEYWORDS_DEFAULTS.airlines),
			context: z.array(z.string()).default(RSS_KEYWORDS_DEFAULTS.context),
		})
		.default(RSS_KEYWORDS_DEFAULTS),
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
	cwd?: string;
	env?: Record<string, string | undefined>;
}): Config {
	const cwd = opts?.cwd ?? process.cwd();
	const path = opts?.path ?? join(cwd, DEFAULT_CONFIG_PATH);
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
	const clone = structuredClone(c);
	clone.secrets = {
		discordWebhookUrl: mask(c.secrets.discordWebhookUrl),
		travelpayoutsToken: mask(c.secrets.travelpayoutsToken),
		serpapiKey: mask(c.secrets.serpapiKey),
	};
	return clone;
}

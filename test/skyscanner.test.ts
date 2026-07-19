import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type {
	AgencyRowRaw,
	BrowserContext,
	CardDom,
	Page,
} from "../src/sources/skyscanner/index";
import {
	SkyscannerBlockedError,
	SkyscannerBrowserSource,
} from "../src/sources/skyscanner/index";
import { Store } from "../src/state/store";
import type { OdPair } from "../src/types";

const cfg = loadConfig({ env: {} });
const now = new Date("2026-07-19T00:00:00Z");
const envOk = { isCI: false, hasBrowser: true, now };
const nrtBkk: OdPair = { origin: "NRT", destination: "BKK", market: "jp" };

const tmpStore = () => new Store(mkdtempSync(join(tmpdir(), "tfw-sky-")));

const ZIP_CARD: CardDom = {
	airlineText: "ZIPAIR",
	transfersText: "直行",
	priceText: "¥15,700",
	departTimeText: "17:05",
};
const KOREAN_CARD: CardDom = {
	airlineText: "大韓航空",
	transfersText: "経由1回",
	priceText: "¥21,300",
};

type PageCalls = {
	newPageCalls: number;
	closeCalls: number;
	gotoUrls: string[];
	collectAgencyCardIndexes: number[];
};

function newCalls(): PageCalls {
	return {
		newPageCalls: 0,
		closeCalls: 0,
		gotoUrls: [],
		collectAgencyCardIndexes: [],
	};
}

function fakePage(
	calls: PageCalls,
	opts: {
		cards?: CardDom[];
		agencyRows?: AgencyRowRaw[];
		blockReason?: string;
		onCollectAgency?: () => AgencyRowRaw[];
	} = {},
): Page {
	return {
		async gotoSearch(url) {
			calls.gotoUrls.push(url);
		},
		async dismissConsent() {},
		async detectBlock() {
			return opts.blockReason;
		},
		async collectCards() {
			return opts.cards ?? [];
		},
		async collectAgencyRows(cardIndex: number) {
			calls.collectAgencyCardIndexes.push(cardIndex);
			if (opts.onCollectAgency) return opts.onCollectAgency();
			return opts.agencyRows ?? [];
		},
		async close() {
			calls.closeCalls++;
		},
	};
}

function fakeLaunch(
	pages: Page[],
	calls: PageCalls,
): {
	launchPersistent: () => Promise<BrowserContext>;
	contextCloseCalls: () => number;
} {
	let idx = 0;
	let contextCloseCalls = 0;
	const context: BrowserContext = {
		async newPage() {
			calls.newPageCalls++;
			const p = pages[idx++];
			if (!p) throw new Error("test double: no more fake pages configured");
			return p;
		},
		async close() {
			contextCloseCalls++;
		},
	};
	return {
		launchPersistent: async () => context,
		contextCloseCalls: () => contextCloseCalls,
	};
}

describe("SkyscannerBrowserSource.available", () => {
	test("!isCI && hasBrowser && enabled && cooldown無し → true", () => {
		const src = new SkyscannerBrowserSource(cfg);
		expect(src.available(envOk)).toBe(true);
	});
	test("isCI=true → false", () => {
		const src = new SkyscannerBrowserSource(cfg);
		expect(src.available({ isCI: true, hasBrowser: true, now })).toBe(false);
	});
	test("hasBrowser=false → false", () => {
		const src = new SkyscannerBrowserSource(cfg);
		expect(src.available({ isCI: false, hasBrowser: false, now })).toBe(false);
	});
	test("cfg.skyscanner.enabled=false → false", () => {
		const disabled = loadConfig({ env: {} });
		disabled.skyscanner.enabled = false;
		const src = new SkyscannerBrowserSource(disabled);
		expect(src.available(envOk)).toBe(false);
	});
	test("storeを渡さない場合はcooldown判定が常にfalse(=available()に影響しない)", () => {
		const src = new SkyscannerBrowserSource(cfg, {});
		expect(src.available(envOk)).toBe(true);
	});
	test("store.breakers.skyscanner.openUntilが未来ならavailable=false(cooldown中)", () => {
		const store = tmpStore();
		store.writeState({
			lastRuns: {},
			rssSeen: {},
			breakers: {
				skyscanner: { failures: 1, openUntil: "2026-07-19T06:00:00Z" },
			},
			verifyQueue: [],
		});
		const src = new SkyscannerBrowserSource(cfg, { store });
		expect(
			src.available({
				isCI: false,
				hasBrowser: true,
				now: new Date("2026-07-19T01:00:00Z"),
			}),
		).toBe(false);
	});
	test("cooldownのopenUntilを過ぎていればavailable=true(満了)", () => {
		const store = tmpStore();
		store.writeState({
			lastRuns: {},
			rssSeen: {},
			breakers: {
				skyscanner: { failures: 1, openUntil: "2026-07-19T06:00:00Z" },
			},
			verifyQueue: [],
		});
		const src = new SkyscannerBrowserSource(cfg, { store });
		expect(
			src.available({
				isCI: false,
				hasBrowser: true,
				now: new Date("2026-07-19T07:00:00Z"),
			}),
		).toBe(true);
	});
});

describe("SkyscannerBrowserSource.sweep", () => {
	test("カードをFareObservation化する(source/market/transfers/foundAt/expiresAt/id)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { cards: [ZIP_CARD, KOREAN_CARD] });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, { launchPersistent, now });

		const got = await src.sweep([nrtBkk], {
			from: "2026-08-18",
			to: "2026-08-18",
		});

		expect(got.length).toBe(2);
		const zip = got.find((o) => o.airline === "ZIPAIR");
		if (!zip) throw new Error("expected ZIPAIR observation");
		expect(zip.source).toBe("skyscanner");
		expect(zip.origin).toBe("NRT");
		expect(zip.destination).toBe("BKK");
		expect(zip.departDate).toBe("2026-08-18");
		expect(zip.departAt).toBe("2026-08-18T17:05:00");
		expect(zip.transfers).toBe(0);
		expect(zip.priceJpy).toBe(15700);
		expect(zip.market).toBe("jp");
		expect(zip.foundAt).toBe(now.toISOString());
		expect(zip.expiresAt).toBeDefined();
		expect(zip.id).toMatch(/^[0-9a-f]{12}$/);
	});

	test("複数ペアはdeps.sleepでレート制御される(ペア間N-1回のみ)", async () => {
		const calls = newCalls();
		const pageA = fakePage(calls, { cards: [ZIP_CARD] });
		const pageB = fakePage(calls, { cards: [ZIP_CARD] });
		const { launchPersistent } = fakeLaunch([pageA, pageB], calls);
		const tinyCfg = {
			...cfg,
			browser: { ...cfg.browser, min_interval_sec: 0.01, jitter_sec: 0.01 },
		};
		const sleptMs: number[] = [];
		const sleep = (ms: number) => {
			sleptMs.push(ms);
			return Promise.resolve();
		};
		const src = new SkyscannerBrowserSource(tinyCfg, {
			launchPersistent,
			now,
			sleep,
		});

		const pairB: OdPair = { origin: "OSA", destination: "BKK", market: "jp" };
		await src.sweep([nrtBkk, pairB], { from: "2026-08-18", to: "2026-08-18" });

		expect(sleptMs.length).toBe(1);
	});

	test("ブロック検出(detectBlock)ならSkyscannerBlockedErrorをthrowし、storeにcooldownを開く", async () => {
		const calls = newCalls();
		const store = tmpStore();
		const page = fakePage(calls, { blockReason: "press-and-hold challenge" });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, {
			launchPersistent,
			now,
			store,
		});

		await expect(
			src.sweep([nrtBkk], { from: "2026-08-18", to: "2026-08-18" }),
		).rejects.toBeInstanceOf(SkyscannerBlockedError);

		const breaker = store.readState().breakers.skyscanner;
		expect(breaker?.openUntil).toBeDefined();
		expect(new Date(breaker?.openUntil ?? 0).getTime()).toBe(
			now.getTime() + cfg.skyscanner.cooldown_hours * 3_600_000,
		);
		expect(src.available({ isCI: false, hasBrowser: true, now })).toBe(false);
	});

	test("カードが0件(パース不能=CAPTCHA/ブロック相当)ならSkyscannerBlockedErrorをthrowしcooldownを開く", async () => {
		const calls = newCalls();
		const store = tmpStore();
		const page = fakePage(calls, { cards: [] });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, {
			launchPersistent,
			now,
			store,
		});

		await expect(
			src.sweep([nrtBkk], { from: "2026-08-18", to: "2026-08-18" }),
		).rejects.toBeInstanceOf(SkyscannerBlockedError);
		expect(store.readState().breakers.skyscanner?.openUntil).toBeDefined();
	});

	test("成功時はstoreのfailuresが0にリセットされる(以前の失敗回数を引き継がない)", async () => {
		const calls = newCalls();
		const store = tmpStore();
		store.writeState({
			lastRuns: {},
			rssSeen: {},
			breakers: { skyscanner: { failures: 2 } },
			verifyQueue: [],
		});
		const page = fakePage(calls, { cards: [ZIP_CARD] });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, {
			launchPersistent,
			now,
			store,
		});

		await src.sweep([nrtBkk], { from: "2026-08-18", to: "2026-08-18" });
		expect(store.readState().breakers.skyscanner?.failures).toBe(0);
	});

	test("context.close()は正常時・例外時のいずれもfinallyで呼ばれる", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { cards: [] });
		const { launchPersistent, contextCloseCalls } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, { launchPersistent, now });
		await src
			.sweep([nrtBkk], { from: "2026-08-18", to: "2026-08-18" })
			.catch(() => {});
		expect(contextCloseCalls()).toBe(1);
		expect(calls.closeCalls).toBe(1);
	});
});

describe("SkyscannerBrowserSource.verify", () => {
	test("最安カードのみsellersを持ち、trustはclassifySeller経由で決まる(バッジ→trusted_ota)", async () => {
		const calls = newCalls();
		const agencyRows: AgencyRowRaw[] = [
			{ agency: "ZIPAIR", priceText: "¥15,700" }, // airline-direct(legAirlinesと一致)
			{
				agency: "TravelHub",
				priceText: "¥15,400",
				badgeText: "おすすめの提供会社",
			}, // badge→trusted_ota
			{ agency: "Trip.com", priceText: "¥15,900" }, // allowlist→trusted_ota
			{ agency: "GoFlyCheap", priceText: "¥15,850" }, // 無バッジ&allowlist外→reference
		];
		const page = fakePage(calls, {
			cards: [ZIP_CARD, KOREAN_CARD],
			agencyRows,
		});
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, { launchPersistent, now });

		const got = await src.verify(nrtBkk, "2026-08-18");

		expect(got.length).toBe(2);
		const zip = got.find((o) => o.airline === "ZIPAIR");
		const korean = got.find((o) => o.airline === "大韓航空");
		if (!zip || !korean) throw new Error("expected both offers");
		expect(zip.source).toBe("skyscanner");
		expect(zip.market).toBe("jp");
		expect(korean.sellers).toEqual([]); // 最安(ZIPAIR ¥15,700)ではないのでsellersは空

		const bySeller = new Map(zip.sellers.map((s) => [s.seller, s]));
		expect(bySeller.get("ZIPAIR")?.trust).toBe("airline");
		expect(bySeller.get("ZIPAIR")?.isAirlineDirect).toBe(true);
		expect(bySeller.get("TravelHub")?.trust).toBe("trusted_ota");
		expect(bySeller.get("Trip.com")?.trust).toBe("trusted_ota");
		expect(bySeller.get("GoFlyCheap")?.trust).toBe("reference");
		// 最安行でagency一覧を開く際、対象カードのindex(0)がcollectAgencyRowsに渡る。
		expect(calls.collectAgencyCardIndexes).toEqual([0]);
	});

	test("cfg.skyscanner.trust_recommended_badge=falseならバッジを無視する(reference側に落ちる)", async () => {
		const calls = newCalls();
		const noBadgeCfg = {
			...cfg,
			skyscanner: { ...cfg.skyscanner, trust_recommended_badge: false },
		};
		const agencyRows: AgencyRowRaw[] = [
			{
				agency: "TravelHub",
				priceText: "¥15,400",
				badgeText: "おすすめの提供会社",
			},
		];
		const page = fakePage(calls, { cards: [ZIP_CARD], agencyRows });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(noBadgeCfg, {
			launchPersistent,
			now,
		});

		const got = await src.verify(nrtBkk, "2026-08-18");
		expect(got[0]?.sellers[0]?.trust).toBe("reference");
	});

	test("agency一覧の取得が失敗してもベストエフォートで価格オファーは返す(sellersは空)", async () => {
		const calls = newCalls();
		const page = fakePage(calls, {
			cards: [ZIP_CARD],
			onCollectAgency: () => {
				throw new Error("agency panel not found");
			},
		});
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, { launchPersistent, now });

		const got = await src.verify(nrtBkk, "2026-08-18");
		expect(got.length).toBe(1);
		expect(got[0]?.sellers).toEqual([]);
	});

	test("ブロック検出ならSkyscannerBlockedErrorをthrowしcooldownを開く", async () => {
		const calls = newCalls();
		const store = tmpStore();
		const page = fakePage(calls, { blockReason: "通常と異なるトラフィック" });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, {
			launchPersistent,
			now,
			store,
		});

		await expect(src.verify(nrtBkk, "2026-08-18")).rejects.toBeInstanceOf(
			SkyscannerBlockedError,
		);
		expect(store.readState().breakers.skyscanner?.openUntil).toBeDefined();
	});

	test("結果カードが0件ならSkyscannerBlockedErrorをthrowする", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { cards: [] });
		const { launchPersistent } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, { launchPersistent, now });
		await expect(src.verify(nrtBkk, "2026-08-18")).rejects.toBeInstanceOf(
			SkyscannerBlockedError,
		);
	});

	test("context.close()/page.close()は正常時・例外時のいずれもfinallyで呼ばれる", async () => {
		const calls = newCalls();
		const page = fakePage(calls, { cards: [] });
		const { launchPersistent, contextCloseCalls } = fakeLaunch([page], calls);
		const src = new SkyscannerBrowserSource(cfg, { launchPersistent, now });
		await src.verify(nrtBkk, "2026-08-18").catch(() => {});
		expect(contextCloseCalls()).toBe(1);
		expect(calls.closeCalls).toBe(1);
	});
});

describe("SkyscannerBlockedError", () => {
	test("Errorのサブクラスでnameが設定される", () => {
		const err = new SkyscannerBlockedError("test reason");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("SkyscannerBlockedError");
		expect(err.message).toContain("test reason");
	});
});

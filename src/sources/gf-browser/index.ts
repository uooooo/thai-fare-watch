import type { Config } from "../../config";
import type {
	DateRange,
	FareObservation,
	OdPair,
	SellerOffer,
	VerifiedOffer,
} from "../../types";
import { datesInRange } from "../../util/dates";
import { stableId } from "../../util/hash";
import type { FareSource, RunnerEnv } from "../types";
import {
	parseBookingAria,
	parseBookingRows,
	parseGridAria,
	parseResultRows,
	type RowRaw,
} from "./parse";

// Playwrightの実Browser/Pageは巨大なインターフェースなので、GfBrowserSourceが実際に
// 使う操作だけをここで自前定義する。実PlaywrightのBrowser/Pageはこの最小形を構造的に
// 満たす("as unknown as"でdefaultLaunch内で1箇所だけ変換する)ため、ユニットテストは
// この最小形を満たす素朴なfakeオブジェクトだけで完全に差し替えられる
// (=実ブラウザを一切起動せずに済む)。DOM操作(selector等)の詳細はwrapPage内に閉じ込め、
// ベストエフォート実装として扱う(実DOMとズレていても構造上はここだけの修正で済む)。
export type Page = {
	gotoFlights(url: string): Promise<void>;
	dismissConsent(): Promise<void>;
	openDateGrid(): Promise<void>;
	collectAriaLabels(filter: "grid" | "result" | "booking"): Promise<string[]>;
	clickResultRow(ariaLabel: string): Promise<void>;
	close(): Promise<void>;
};

export type Browser = {
	newPage(opts?: { locale?: string }): Promise<Page>;
	close(): Promise<void>;
};

export type GfBrowserDeps = {
	launch?: () => Promise<Browser>;
	now?: Date;
	// レート制御用の待機を注入可能にする(既定はBun.sleep)。テストがグローバルなBun.sleep
	// を書き換えずに、決定的なノーオップ/計測用の実装を渡せるようにするため。
	sleep?: (ms: number) => Promise<void>;
};

const SWEEP_EXPIRES_HOURS = 6;

// sweep/verifyの操作間レート制御。cfg.browser.min_interval_sec 〜
// +cfg.browser.jitter_sec 秒(ミリ秒換算)。randは既定でMath.randomだが、テストでは
// 決定的な値(0や0.5)を注入して計算式そのものを検証できるようにexportする。
export function rateLimitMs(
	cfg: Config,
	rand: () => number = Math.random,
): number {
	return (
		(cfg.browser.min_interval_sec + rand() * cfg.browser.jitter_sec) * 1000
	);
}

function buildFlightsUrl(
	origin: string,
	destination: string,
	date: string,
): string {
	const q = `${origin} to ${destination} on ${date} one way`;
	const params = new URLSearchParams({ hl: "ja", gl: "jp", curr: "JPY", q });
	return `https://www.google.com/travel/flights?${params.toString()}`;
}

// 0件は実データが無いだけでなく、CAPTCHA/ブロックによって何も取得できていない
// 可能性がある。どちらであれ「使い物にならない」ので同じくthrowし、呼び出し元
// (pipeline)のヘルス記録に反映させる。
function assertUsable(labels: string[], context: string): void {
	if (labels.length === 0) {
		throw new Error(
			`gf-browser: ${context}: no results (possible CAPTCHA or block)`,
		);
	}
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		out.push(item);
	}
	return out;
}

export class GfBrowserSource implements FareSource {
	name = "gf-browser";
	private readonly cfg: Config;
	private readonly launch: () => Promise<Browser>;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(cfg: Config, deps?: GfBrowserDeps) {
		this.cfg = cfg;
		this.launch = deps?.launch ?? (() => defaultLaunch(cfg));
		const fixedNow = deps?.now;
		this.now = () => fixedNow ?? new Date();
		this.sleep = deps?.sleep ?? Bun.sleep;
	}

	available(env: RunnerEnv): boolean {
		return !env.isCI && env.hasBrowser && this.cfg.browser.enabled !== false;
	}

	// ペアごとに日付グリッドを開いて価格付きセルを収集する。グリッドは価格のみで
	// 便情報(便名/時刻/航空会社)が無いため、transfersは0固定のunverified観測として
	// expiresAt=+6hを設定する(risk判定には使わない掃引専用データ)。
	async sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]> {
		const browser = await this.launch();
		try {
			const out: FareObservation[] = [];
			const validDates = new Set(datesInRange(range));
			const year = Number(range.from.slice(0, 4));

			for (let i = 0; i < pairs.length; i++) {
				const pair = pairs[i];
				if (!pair) continue;
				const page = await browser.newPage({ locale: "ja-JP" });
				try {
					await page.gotoFlights(
						buildFlightsUrl(pair.origin, pair.destination, range.from),
					);
					await page.dismissConsent();
					await page.openDateGrid();
					const labels = await page.collectAriaLabels("grid");
					assertUsable(labels, `sweep ${pair.origin}->${pair.destination}`);

					const cells = parseGridAria(labels, year);
					const foundAt = this.now().toISOString();
					const expiresAt = new Date(
						this.now().getTime() + SWEEP_EXPIRES_HOURS * 3_600_000,
					).toISOString();
					for (const cell of cells) {
						if (!validDates.has(cell.date)) continue;
						out.push({
							id: stableId(
								"gf",
								pair.origin,
								pair.destination,
								cell.date,
								undefined,
								cell.priceJpy,
							),
							source: "gf-browser",
							origin: pair.origin,
							destination: pair.destination,
							departDate: cell.date,
							transfers: 0,
							priceJpy: cell.priceJpy,
							market: pair.market,
							foundAt,
							expiresAt,
						});
					}
				} finally {
					await page.close();
				}
				if (i < pairs.length - 1) await this.sleep(rateLimitMs(this.cfg));
			}
			return dedupeById(out);
		} finally {
			await browser.close();
		}
	}

	// 対象日の結果行を取得→最安行をクリック→予約オプション行を読む。販売元は
	// trust:"reference"の仮置きで返す(verify.tsのapplyTrustが確定させる)。
	// 予約オプション取得自体はベストエフォート: 失敗しても価格オファーは返す。
	async verify(od: OdPair, date: string): Promise<VerifiedOffer[]> {
		const browser = await this.launch();
		try {
			const page = await browser.newPage({ locale: "ja-JP" });
			try {
				await page.gotoFlights(
					buildFlightsUrl(od.origin, od.destination, date),
				);
				await page.dismissConsent();
				const resultLabels = await page.collectAriaLabels("result");
				assertUsable(
					resultLabels,
					`verify ${od.origin}->${od.destination} ${date}`,
				);

				// Googleの実DOMは検索結果行をbyte-identicalなaria-label文字列として二重に
				// レンダリングする。これをパース前に完全一致(Set)でdedupしておくことで、
				// 「Google側の表示上の重複」と「別便が同一料金になった偶然の一致」を
				// 混同しない(後者はparseResultRows後、departAt/arriveAtが異なるため別idになる)。
				const uniqueLabels = Array.from(new Set(resultLabels));

				const foundAt = this.now().toISOString();
				const paired: Array<{ ariaLabel: string; offer: VerifiedOffer }> = [];
				for (const ariaLabel of uniqueLabels) {
					const row: RowRaw = { ariaLabel, departDate: date };
					const [parsed] = parseResultRows([row]);
					if (!parsed) continue;
					paired.push({
						ariaLabel,
						offer: {
							...parsed,
							// flightNumberはgf-browserでは常にundefined(結果行のaria-labelに
							// 便名が含まれないため)なので、これだけをdiscriminantにすると
							// 同一route/date/価格の別便(例: 出発時刻だけが異なる複数便)が
							// 衝突して脱落する。departAt/arriveAtを含めることで時刻が異なれば
							// 別idになる。
							id: stableId(
								"gf",
								od.origin,
								od.destination,
								date,
								parsed.departAt,
								parsed.arriveAt,
								parsed.priceJpy,
							),
							source: "gf-browser",
							market: od.market,
							foundAt,
							sellers: [],
						},
					});
				}

				const seen = new Set<string>();
				const deduped = paired.filter(({ offer }) => {
					if (seen.has(offer.id)) return false;
					seen.add(offer.id);
					return true;
				});
				if (deduped.length === 0) return [];

				let cheapestIdx = 0;
				for (let i = 1; i < deduped.length; i++) {
					const cur = deduped[i];
					const best = deduped[cheapestIdx];
					if (cur && best && cur.offer.priceJpy < best.offer.priceJpy) {
						cheapestIdx = i;
					}
				}
				const cheapest = deduped[cheapestIdx];
				const sellers = cheapest
					? await this.collectSellers(page, cheapest.ariaLabel)
					: [];

				return deduped.map(({ offer }, i) => ({
					...offer,
					sellers: i === cheapestIdx ? sellers : [],
				}));
			} finally {
				await page.close();
			}
		} finally {
			await browser.close();
		}
	}

	// 最安行をクリックして予約オプション(販売元)行を読む。この段はベストエフォート
	// —取得に失敗しても価格自体のオファーは活かすため、ここでのみ例外を握り潰す。
	private async collectSellers(
		page: Page,
		ariaLabel: string,
	): Promise<SellerOffer[]> {
		try {
			await page.clickResultRow(ariaLabel);
			const bookingLabels = await page.collectAriaLabels("booking");
			const bookingRows = bookingLabels
				.map(parseBookingAria)
				.filter(
					(r): r is { sellerText: string; priceText: string } =>
						r !== undefined,
				);
			const booked = parseBookingRows(bookingRows);
			return booked.map((b) => ({
				seller: b.seller,
				isAirlineDirect: false,
				trust: "reference" as const,
				priceJpy: b.priceJpy,
			}));
		} catch {
			return [];
		}
	}
}

// ---- ベストエフォートのPlaywright DOM駆動レイヤ(ユニットテスト対象外) ----------------
// セレクタは実DOM(2026-07 headlessキャプチャで確認した構造)に基づくが、Google側の
// マークアップ変更で容易にズレうる。ズレた場合はcollectAriaLabels/openDateGrid/
// clickResultRowの中身だけを直せばよいよう、GfBrowserSource本体からはこのレイヤの
// 実装詳細が完全に隠れる構成にしている。

const CONSENT_SELECTORS = [
	'button:has-text("すべて同意")',
	'button:has-text("同意する")',
	'button:has-text("Accept all")',
	'button:has-text("I agree")',
];

const DATE_GRID_SELECTORS = [
	'button:has-text("日付グリッド")',
	'button[aria-label*="日付"]',
	'button:has-text("日付")',
];

// このリポジトリのtsconfigはDOM libを含めない(他のNode/Bun側コードに影響させたくないため)。
// evaluate()に渡す関数本体はPlaywrightにソース文字列としてシリアライズされ、ブラウザ側の
// 実document上で実行されるが、tsc上はDOM lib由来の型名(Document/HTMLElement等)を一切
// 参照できないため、実際に使う分だけのMinimal構造型を自前定義してanyを避ける。
type MinimalElement = {
	getAttribute(name: string): string | null;
	click?: () => void;
};
type MinimalDocument = {
	querySelectorAll(selector: string): Iterable<MinimalElement>;
	querySelector(selector: string): MinimalElement | null;
};

// Playwrightの実Page/Browser型自体は非常に大きいため、遅延importした値をそのまま
// 受け取る箇所だけ最小限の構造で受ける(呼び出すメソッドはwrapPage/wrapBrowser内に閉じる)。
type PwPage = {
	goto(url: string): Promise<unknown>;
	waitForLoadState(state: "networkidle"): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
	click(selector: string, opts?: { timeout?: number }): Promise<void>;
	evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
	close(): Promise<void>;
};
type PwBrowser = {
	newPage(opts?: { locale?: string }): Promise<PwPage>;
	close(): Promise<void>;
};

function wrapPage(pwPage: PwPage): Page {
	return {
		async gotoFlights(url) {
			await pwPage.goto(url);
			await pwPage.waitForLoadState("networkidle").catch(() => {});
			await pwPage.waitForTimeout(2000);
		},
		async dismissConsent() {
			for (const selector of CONSENT_SELECTORS) {
				try {
					await pwPage.click(selector, { timeout: 2000 });
					await pwPage.waitForTimeout(300);
					return;
				} catch {
					// 次のセレクタを試す
				}
			}
		},
		async openDateGrid() {
			for (const selector of DATE_GRID_SELECTORS) {
				try {
					await pwPage.click(selector, { timeout: 3000 });
					await pwPage.waitForTimeout(1500);
					return;
				} catch {
					// 次のセレクタを試す
				}
			}
		},
		async collectAriaLabels(filter) {
			// この関数本体はPlaywrightによってソース文字列としてシリアライズされ、
			// ブラウザ側の実document上で実行される(型はMinimalDocument/MinimalElementで
			// 表現し、DOM lib非依存かつanyを使わずに済ませる)。
			return pwPage.evaluate((f: string) => {
				const doc = (globalThis as unknown as { document: MinimalDocument })
					.document;
				const labels = Array.from(doc.querySelectorAll("[aria-label]")).map(
					(el) => el.getAttribute("aria-label") ?? "",
				);
				if (f === "grid")
					return labels.filter((l: string) => /\d+月\s*\d+日/.test(l));
				if (f === "result") {
					return labels.filter(
						(l: string) => /発.*着/.test(l) && /円|[¥￥]/.test(l),
					);
				}
				return labels.filter((l: string) => /予約手続きに進む|で予約/.test(l));
			}, filter);
		},
		async clickResultRow(ariaLabel) {
			await pwPage.evaluate((label: string) => {
				const doc = (globalThis as unknown as { document: MinimalDocument })
					.document;
				const escaped = label.replace(/"/g, '\\"');
				const el = doc.querySelector(`[aria-label="${escaped}"]`);
				el?.click?.();
			}, ariaLabel);
			await pwPage.waitForTimeout(2000);
		},
		async close() {
			await pwPage.close();
		},
	};
}

function wrapBrowser(pwBrowser: PwBrowser): Browser {
	return {
		async newPage(opts) {
			const pwPage = await pwBrowser.newPage({ locale: opts?.locale });
			return wrapPage(pwPage);
		},
		async close() {
			await pwBrowser.close();
		},
	};
}

// playwrightは実際にsweep/verifyが呼ばれるまでimportしない(lazy import) —
// ユニットテストがdeps.launchを常に注入することで、この関数はテストから一切
// 実行されず、playwrightモジュール自体も読み込まれない。
async function defaultLaunch(cfg: Config): Promise<Browser> {
	const playwright = await import("playwright");
	const launchOpts = { headless: cfg.browser.headless };
	try {
		const browser = await playwright.chromium.launch({
			...launchOpts,
			channel: cfg.browser.channel,
		});
		return wrapBrowser(browser);
	} catch {
		// 指定チャネル(既定"chrome")が無い/起動失敗 → バンドル版Chromiumにフォールバック。
		const browser = await playwright.chromium.launch(launchOpts);
		return wrapBrowser(browser);
	}
}

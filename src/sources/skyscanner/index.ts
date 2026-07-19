import type { Config } from "../../config";
import { classifySeller } from "../../core/trust";
import type { Store } from "../../state/store";
import type {
	DateRange,
	FareObservation,
	OdPair,
	SellerOffer,
	VerifiedOffer,
} from "../../types";
import { stableId } from "../../util/hash";
import { rateLimitMs } from "../gf-browser/index";
import type { FareSource, RunnerEnv } from "../types";
import {
	type AgencyRowRaw,
	parseAgencyRows,
	parseSkyscannerCards,
} from "./parse";

// Page.collectAgencyRowsの戻り型として使うため、parse.tsのAgencyRowRawをこのモジュールの
// 公開面からも参照可能にしておく(テスト等が"./index"だけを見ればよいようにする)。
export type { AgencyRowRaw };

// Skyscanner(PerimeterX+TLSフィンガープリンティング等のbot対策あり)のPlaywright駆動
// アダプタ。gf-browser(Task 15)と同じ構造的パターンに従う: 実Playwrightの
// BrowserContext/Pageは巨大なので、このソースが実際に使う操作だけを最小構造で
// 自前定義する(実PlaywrightはこのPage/BrowserContext形を構造的に満たすため、
// defaultLaunchPersistent内で1箇所だけ"as unknown as"相当のwrap変換をする)。
// ユニットテストはこの最小形を満たす素朴なfakeオブジェクトだけで完全に差し替えられ、
// 実ブラウザ/実ネットワークを一切使わない。
//
// gf-browserとの決定的な違い: Skyscannerは「ブロックされるのが普通」の前提で作る
// (spec: best-effort, DESIGNED to fail gracefully)。ブロック検出(SkyscannerBlockedError)
// はstore経由でcooldownブレーカを開き、以降available()がしばらくfalseを返すことで
// 無駄打ちを防ぐ —このソースが失敗し続けても他ソースが荷を負う設計。
export type CardDom = {
	airlineText: string;
	transfersText: string;
	priceText: string;
	departTimeText?: string;
};

export type Page = {
	gotoSearch(url: string): Promise<void>;
	dismissConsent(): Promise<void>;
	// PerimeterX/CAPTCHA/「通常と異なるトラフィック」/press-and-hold等のブロック兆候を
	// 検出したら理由文字列を返す(見つからなければundefined)。
	detectBlock(): Promise<string | undefined>;
	collectCards(): Promise<CardDom[]>;
	// cardIndexは対象カード(通常は最安)をクリックして開いたagency一覧を読む。
	collectAgencyRows(cardIndex: number): Promise<AgencyRowRaw[]>;
	close(): Promise<void>;
};

export type BrowserContext = {
	newPage(): Promise<Page>;
	close(): Promise<void>;
};

export type SkyscannerDeps = {
	launchPersistent?: () => Promise<BrowserContext>;
	now?: Date;
	store?: Store;
	// レート制御用の待機を注入可能にする(既定はBun.sleep)。gf-browserと同じ理由
	// (テストがグローバルなBun.sleepを書き換えずに決定的な実装を渡せるようにするため)。
	sleep?: (ms: number) => Promise<void>;
};

const SWEEP_EXPIRES_HOURS = 6;
const BREAKER_KEY = "skyscanner";

// PerimeterX/CAPTCHA/「通常と異なるトラフィック」等のブロック兆候を検出した場合、または
// 解析可能な結果が0件だった場合に投げる専用エラー。呼び出し元(sweep/verify)のcatchが
// これを見てstoreへcooldownを書き込み、そのままrethrowしてpipeline側のヘルス記録
// (recordHealthFailure)に反映させる。
export class SkyscannerBlockedError extends Error {
	constructor(message: string) {
		super(`skyscanner: ${message}`);
		this.name = "SkyscannerBlockedError";
	}
}

async function assertNotBlocked(page: Page, context: string): Promise<void> {
	const reason = await page.detectBlock();
	if (reason !== undefined) {
		throw new SkyscannerBlockedError(`${context}: blocked (${reason})`);
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

export class SkyscannerBrowserSource implements FareSource {
	name = "skyscanner";
	private readonly cfg: Config;
	private readonly launchPersistent: () => Promise<BrowserContext>;
	private readonly now: () => Date;
	private readonly store: Store | undefined;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(cfg: Config, deps?: SkyscannerDeps) {
		this.cfg = cfg;
		this.launchPersistent =
			deps?.launchPersistent ?? (() => defaultLaunchPersistent(cfg));
		const fixedNow = deps?.now;
		this.now = () => fixedNow ?? new Date();
		this.store = deps?.store;
		this.sleep = deps?.sleep ?? Bun.sleep;
	}

	available(env: RunnerEnv): boolean {
		return (
			!env.isCI &&
			env.hasBrowser &&
			this.cfg.skyscanner.enabled &&
			!this.inCooldown(env.now)
		);
	}

	// storeが未注入(deps.store省略)なら常にfalse(=cooldown無し)を返す —fliのnoopBreaker
	// と同じ考え方: 永続化先を持たないならブレーカ自体を機能させない安全側デフォルト。
	private inCooldown(now: Date): boolean {
		if (!this.store) return false;
		const breaker = this.store.readState().breakers[BREAKER_KEY];
		if (!breaker?.openUntil) return false;
		return now.getTime() < new Date(breaker.openUntil).getTime();
	}

	// ブロック検出時にcooldownを開く。fliのmakeCiBreakerと同じStateFile.breakers形状
	// ({openUntil?, failures})を再利用するが、fliのCI限定ブレーカ(env.isCIでのみopenする
	// 設計)とは異なり無条件でopenする —Skyscannerはavailable()自体が既に!env.isCIを要求
	// するため、「非CI(ローカル)でだけ実際に動く」ソースにCI限定ブレーカを付けても意味が
	// ない。1回のブロック検出で即座に開く(fliのような連続失敗閾値は設けない —Skyscanner
	// の失敗は「たまたま」ではなくbot対策そのものである可能性が高く、閾値を待つ間に
	// 追加リクエストを送ること自体がリスクを増やすため)。
	private openCooldown(): void {
		if (!this.store) return;
		const state = this.store.readState();
		const prevFailures = state.breakers[BREAKER_KEY]?.failures ?? 0;
		state.breakers[BREAKER_KEY] = {
			failures: prevFailures + 1,
			openUntil: new Date(
				this.now().getTime() + this.cfg.skyscanner.cooldown_hours * 3_600_000,
			).toISOString(),
		};
		this.store.writeState(state);
	}

	private recordSuccess(): void {
		if (!this.store) return;
		const state = this.store.readState();
		state.breakers[BREAKER_KEY] = { failures: 0 };
		this.store.writeState(state);
	}

	// sweep/verify共通の外枠: context起動→finally close、成功でrecordSuccess、
	// 失敗(ブロック検出含む全ての例外)でopenCooldown+rethrow。
	// NOTE(自己レビュー用): ここは「ブロック検出(SkyscannerBlockedError)以外の予期しない
	// 例外(例: DOM構造ズレによる例外、ナビゲーションタイムアウト)」もcooldownを開く対象に
	// している。Skyscannerの失敗モードはbot対策が支配的で、失敗の種類を精密に切り分ける
	// メリットが薄い一方、誤って何度も即時リトライする方が実害(ブロック継続・IP評判悪化)
	// が大きいため、保守的に「どんな失敗でも一旦退く」を選んだ(spec上は「ブロック検出時に
	// cooldownを開く」としか書かれていないので、これは意図的な安全側の拡大解釈である)。
	private async withContext<T>(
		fn: (context: BrowserContext) => Promise<T>,
	): Promise<T> {
		const context = await this.launchPersistent();
		try {
			const result = await fn(context);
			this.recordSuccess();
			return result;
		} catch (err) {
			this.openCooldown();
			throw err;
		} finally {
			await context.close();
		}
	}

	// 対象日(range.from)1日分のみを各ペアで検索する単日プローブ(gf-browserの日付グリッド
	// 掃引とは異なり、Skyscanner側にカレンダーグリッドUIの自動化を実装していないため)。
	// best-effort/degraded前提のソースであり、bot対策下で日付分ページ遷移を重ねること自体が
	// ブロックリスクを上げるため、意図的にrange全体ではなく1日だけを見る(詳細は
	// task-15b-report.mdのConcerns参照)。
	async sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]> {
		return this.withContext((context) =>
			this.sweepInner(context, pairs, range),
		);
	}

	private async sweepInner(
		context: BrowserContext,
		pairs: OdPair[],
		range: DateRange,
	): Promise<FareObservation[]> {
		const out: FareObservation[] = [];
		const foundAt = this.now().toISOString();
		const expiresAt = new Date(
			this.now().getTime() + SWEEP_EXPIRES_HOURS * 3_600_000,
		).toISOString();

		for (let i = 0; i < pairs.length; i++) {
			const pair = pairs[i];
			if (!pair) continue;
			const page = await context.newPage();
			try {
				await page.gotoSearch(
					buildSearchUrl(
						pair.origin,
						pair.destination,
						range.from,
						this.cfg.skyscanner.market,
					),
				);
				await page.dismissConsent();
				await assertNotBlocked(
					page,
					`sweep ${pair.origin}->${pair.destination}`,
				);

				const cardDoms = await page.collectCards();
				const cards = parseSkyscannerCards(
					cardDoms.map((c) => ({
						...c,
						origin: pair.origin,
						destination: pair.destination,
						departDate: range.from,
					})),
				);
				// 0件は実データが無いだけでなく、bot対策ブロックで何も取得できていない可能性が
				// ある(gf-browserのassertUsableと同じ考え方)。どちらであれ使い物にならないので
				// throwし、cooldownを開く。
				if (cards.length === 0) {
					throw new SkyscannerBlockedError(
						`sweep ${pair.origin}->${pair.destination}: no parseable cards (possible block)`,
					);
				}
				for (const c of cards) {
					out.push({
						...c,
						id: stableId(
							"sky",
							c.origin,
							c.destination,
							c.departDate,
							c.airline,
							c.departAt,
							c.transfers,
							c.priceJpy,
						),
						source: "skyscanner",
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
	}

	// 対象日の結果カードを取得→最安カードをクリック→agency一覧(販売元+バッジ)を読む。
	// 各sellerのtrustはこの場でclassifySeller(recommendedBadge込み)によって確定させる
	// (gf-browserのようにtrust:"reference"仮置き+後段のapplyTrust確定に委ねない) —
	// 理由: SellerOffer型にはrecommendedBadgeを保持するフィールドが無いため、ここで
	// バッジ情報を使わずに仮のtrustを置くと、後段で再度applyTrustされた際にバッジ由来の
	// trusted_ota判定が再現できず失われてしまう(バッジという入力そのものが忘却される)。
	// このため、Skyscannerアダプタ自身がバッジを見られる唯一のこの時点で確定させておく。
	async verify(od: OdPair, date: string): Promise<VerifiedOffer[]> {
		return this.withContext((context) => this.verifyInner(context, od, date));
	}

	private async verifyInner(
		context: BrowserContext,
		od: OdPair,
		date: string,
	): Promise<VerifiedOffer[]> {
		const page = await context.newPage();
		try {
			await page.gotoSearch(
				buildSearchUrl(
					od.origin,
					od.destination,
					date,
					this.cfg.skyscanner.market,
				),
			);
			await page.dismissConsent();
			await assertNotBlocked(
				page,
				`verify ${od.origin}->${od.destination} ${date}`,
			);

			const cardDoms = await page.collectCards();
			const cards = parseSkyscannerCards(
				cardDoms.map((c) => ({
					...c,
					origin: od.origin,
					destination: od.destination,
					departDate: date,
				})),
			);
			if (cards.length === 0) {
				throw new SkyscannerBlockedError(
					`verify ${od.origin}->${od.destination} ${date}: no parseable cards (possible block)`,
				);
			}

			const foundAt = this.now().toISOString();
			const offers: VerifiedOffer[] = cards.map((c) => ({
				...c,
				id: stableId(
					"sky",
					c.origin,
					c.destination,
					c.departDate,
					c.airline,
					c.departAt,
					c.transfers,
					c.priceJpy,
				),
				source: "skyscanner",
				market: od.market,
				foundAt,
				sellers: [],
			}));

			let cheapestIdx = 0;
			for (let i = 1; i < offers.length; i++) {
				const cur = offers[i];
				const best = offers[cheapestIdx];
				if (cur && best && cur.priceJpy < best.priceJpy) cheapestIdx = i;
			}
			const cheapest = offers[cheapestIdx];
			const sellers = cheapest
				? await this.collectSellers(page, cheapestIdx, cheapest.airline)
				: [];

			return offers.map((o, i) => ({
				...o,
				sellers: i === cheapestIdx ? sellers : [],
			}));
		} finally {
			await page.close();
		}
	}

	// agency一覧の取得・パースはベストエフォート —失敗しても価格オファー自体は活かす
	// (gf-browserのcollectSellersと同じ方針)。
	private async collectSellers(
		page: Page,
		cardIndex: number,
		airline: string | undefined,
	): Promise<SellerOffer[]> {
		try {
			const rows = await page.collectAgencyRows(cardIndex);
			const parsed = parseAgencyRows(rows);
			return parsed.map((p) => {
				const trust = classifySeller(
					{
						seller: p.seller,
						legAirlines: airline ? [airline] : [],
						// trust_recommended_badge=falseならバッジ信号そのものを渡さない
						// (=classifySeller rule 3を素通りさせ、allowlist/airline判定のみに戻す)。
						recommendedBadge: this.cfg.skyscanner.trust_recommended_badge
							? p.recommendedBadge
							: false,
					},
					this.cfg.trusted_otas,
				);
				return {
					seller: p.seller,
					isAirlineDirect: trust === "airline",
					trust,
					priceJpy: p.priceJpy,
				};
			});
		} catch {
			return [];
		}
	}
}

// Skyscannerのdeep-link検索URL(ja-JP/JPY、one-way)。ドキュメント化された既知の形式
// (https://www.skyscanner.jp/transport/flights/{origin}/{dest}/{yymmdd}/ + currency/
// market/locale query)を基に組み立てる —Live capture試行がブロックされたため実キャプチャ
// では裏付けられていない(task-15b-report.md参照)。ブロック時はURL形状より先にPerimeterXの
// interstitialに阻まれる可能性が高く、このURL自体の精度が結果を左右する場面は限られる。
function buildSearchUrl(
	origin: string,
	destination: string,
	date: string,
	market: string,
): string {
	const yymmdd = date.replace(/-/g, "").slice(2);
	const params = new URLSearchParams({
		adultsv2: "1",
		cabinclass: "economy",
		rtn: "0",
		currency: "JPY",
		market,
		locale: "ja-JP",
	});
	const path = `${origin.toLowerCase()}/${destination.toLowerCase()}/${yymmdd}`;
	return `https://www.skyscanner.jp/transport/flights/${path}/?${params.toString()}`;
}

// ---- ベストエフォートのPlaywright DOM駆動レイヤ(ユニットテスト対象外) ----------------
// gf-browserのwrapPage/wrapBrowserと同じ位置づけ: セレクタ/抽出ロジックは実DOM未確認
// (Live capture試行がブロックされたため)であり、Skyscanner側のマークアップ変更・
// 見た目の相違で容易にズレうる。ズレた場合はこのレイヤ内(detectBlockOnPwPage/
// collectCardsFromPwPage/collectAgencyRowsFromPwPage)だけを直せばよいよう、
// SkyscannerBrowserSource本体からはこのレイヤの実装詳細が完全に隠れる構成にしている。

const NAV_TIMEOUT_MS = 20_000;
const DEFAULT_PROFILE_DIR = ".skyscanner-profile";

const BLOCK_TEXT_PATTERNS: RegExp[] = [
	/perimeterx/i,
	/press\s*(?:&|and)\s*hold/i,
	/captcha/i,
	/通常と異なるトラフィック/,
	/unusual traffic/i,
	/are you a robot/i,
	/verify you are human/i,
];

// このリポジトリのtsconfigはDOM libを含めない。evaluate()に渡す関数本体は
// Playwrightにソース文字列としてシリアライズされブラウザ側の実document上で実行される
// (gf-browserと同じ制約)。実際に使う分だけのMinimal構造型を自前定義してanyを避ける。
type MinimalElement = {
	innerText?: string;
	querySelector(selector: string): MinimalElement | null;
};
type MinimalDocument = {
	querySelectorAll(selector: string): Iterable<MinimalElement>;
};

type PwPage = {
	goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
	waitForLoadState(state: "networkidle"): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
	title(): Promise<string>;
	content(): Promise<string>;
	click(selector: string, opts?: { timeout?: number }): Promise<void>;
	evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
	close(): Promise<void>;
};
type PwBrowserContext = {
	newPage(): Promise<PwPage>;
	close(): Promise<void>;
	setDefaultNavigationTimeout?(ms: number): void;
};

const CONSENT_SELECTORS = [
	'button:has-text("すべて同意")',
	'button:has-text("同意する")',
	'button:has-text("Accept all")',
	'button:has-text("I agree")',
];

// 価格らしき文字列を含む汎用要素をスキャンし、残りのテキストを名称側とみなすヒューリスティック
// (record-gf-fixture.tsのbooking-options抽出と同じ発想)。実際の正規表現はcollectCards/
// collectAgencyRowsのevaluate()コールバック内でそれぞれ定義する —この関数本体はPlaywrightに
// ソース文字列としてシリアライズされブラウザ側で実行されるため、外側(このモジュール)の
// クロージャ変数を参照できない(gf-browserのwrapPageコメントと同じ制約)。

async function detectBlockOnPwPage(
	pwPage: PwPage,
): Promise<string | undefined> {
	const [title, html] = await Promise.all([
		pwPage.title().catch(() => ""),
		pwPage.content().catch(() => ""),
	]);
	const haystack = `${title}\n${html}`;
	for (const re of BLOCK_TEXT_PATTERNS) {
		if (re.test(haystack)) return re.source;
	}
	return undefined;
}

function wrapPage(pwPage: PwPage): Page {
	return {
		async gotoSearch(url) {
			await pwPage.goto(url, { timeout: NAV_TIMEOUT_MS });
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
		async detectBlock() {
			return detectBlockOnPwPage(pwPage);
		},
		async collectCards() {
			// 実セレクタ未確認(best-effort): 価格文字列を含む要素を総当たりし、テキスト全体から
			// 航空会社名/経由数/出発時刻をそれらしく抜き出す。実DOMで確認できたら
			// ここだけを精密なセレクタに差し替える。
			return pwPage.evaluate(() => {
				const doc = (globalThis as unknown as { document: MinimalDocument })
					.document;
				const priceRe = /[¥￥]\s*[\d,]+|[\d,]+\s*円/;
				const timeRe = /\d{1,2}:\d{2}/;
				const out: {
					airlineText: string;
					transfersText: string;
					priceText: string;
					departTimeText?: string;
				}[] = [];
				const candidates = Array.from(
					doc.querySelectorAll(
						'[data-testid*="itinerary"], li, div[role="listitem"]',
					),
				);
				for (const el of candidates) {
					const text = el.innerText?.trim() ?? "";
					if (!text || text.length > 400) continue;
					const priceMatch = text.match(priceRe);
					if (!priceMatch) continue;
					const timeMatch = text.match(timeRe);
					const transfersText = /直行|nonstop|direct/i.test(text)
						? "直行"
						: text;
					out.push({
						airlineText: text.replace(priceMatch[0], "").trim().slice(0, 60),
						transfersText,
						priceText: priceMatch[0],
						departTimeText: timeMatch?.[0],
					});
				}
				return out;
			});
		},
		async collectAgencyRows(cardIndex) {
			// 最安カード(既定index=0付近)をクリックしてagency一覧パネルを開く試み。
			// 実DOM未確認のためベストエフォート(失敗時は呼び出し側collectSellersが握り潰す)。
			await pwPage.click(
				`[data-testid*="itinerary"]:nth-of-type(${cardIndex + 1})`,
				{ timeout: 3000 },
			);
			await pwPage.waitForTimeout(1500);
			return pwPage.evaluate(() => {
				const doc = (globalThis as unknown as { document: MinimalDocument })
					.document;
				const priceRe = /[¥￥]\s*[\d,]+|[\d,]+\s*円/;
				const out: { agency: string; priceText: string; badgeText?: string }[] =
					[];
				const candidates = Array.from(
					doc.querySelectorAll('[data-testid*="provider"], li, tr'),
				);
				// なりすまし対策: バッジは行テキスト全体からではなく、バッジ専用の隔離要素
				// からのみ読む。行テキストにバッジ文言(おすすめ等)が紛れていても、それが
				// 販売元名の一部なら信頼バッジとして扱わない。名前も同様にバッジ要素の
				// テキストを除去してから確定する。
				const BADGE_SEL =
					'[class*="badge" i],[class*="recommend" i],[data-testid*="recommend" i],[aria-label*="recommend" i],[aria-label*="おすすめ" i]';
				const NAME_SEL =
					'[data-testid*="provider-name" i],[class*="provider-name" i],[class*="agent" i]';
				for (const el of candidates) {
					const text = el.innerText?.trim() ?? "";
					if (!text || text.length > 200) continue;
					const priceMatch = text.match(priceRe);
					if (!priceMatch) continue;
					// バッジは隔離要素のテキストのみ(存在しなければundefined)。
					const badgeEl = el.querySelector(BADGE_SEL);
					const badgeText = badgeEl?.innerText?.trim() || undefined;
					// 名前は専用要素があればそれを使い、無ければ行テキストから価格とバッジ
					// テキストを除去して求める(バッジ文言が名前に残らないようにする)。
					const nameEl = el.querySelector(NAME_SEL);
					let agency = nameEl?.innerText?.trim() ?? "";
					if (!agency) {
						agency = text.replace(priceMatch[0], "").trim();
						if (badgeText) agency = agency.replace(badgeText, "").trim();
					}
					if (!agency) continue;
					out.push({ agency, priceText: priceMatch[0], badgeText });
				}
				return out;
			});
		},
		async close() {
			await pwPage.close();
		},
	};
}

function wrapContext(pwContext: PwBrowserContext): BrowserContext {
	return {
		async newPage() {
			const pwPage = await pwContext.newPage();
			return wrapPage(pwPage);
		},
		async close() {
			await pwContext.close();
		},
	};
}

// playwrightは実際にsweep/verifyが呼ばれるまでimportしない(lazy import) —
// ユニットテストがdeps.launchPersistentを常に注入することで、この関数はテストから一切
// 実行されず、playwrightモジュール自体も読み込まれない(gf-browserのdefaultLaunchと同じ規約)。
//
// user_data_dirが空文字("": 既定)の場合はリポジトリ配下の.skyscanner-profile/を使う
// (.gitignore登録済み)。headless既定falseは、Skyscannerが素のheadless自動化を検出し
// やすいという前提に基づく(config.tsのSKYSCANNER_DEFAULTSコメント参照)。
async function defaultLaunchPersistent(cfg: Config): Promise<BrowserContext> {
	const playwright = await import("playwright");
	const userDataDir =
		cfg.skyscanner.user_data_dir.trim() !== ""
			? cfg.skyscanner.user_data_dir
			: DEFAULT_PROFILE_DIR;
	const context = await playwright.chromium.launchPersistentContext(
		userDataDir,
		{
			channel: "chrome",
			headless: cfg.skyscanner.headless,
			locale: "ja-JP",
		},
	);
	context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
	return wrapContext(context);
}

#!/usr/bin/env bun
// Skyscanner(ja-JP)からNRT→BKKの実DOM構造を採取し、
// test/fixtures/skyscanner/live/{cards.json, agency-rows.json, page.html, result.txt} に
// 保存するBEST-EFFORTスクリプト(Task 15b)。
//
// Usage: bun run scripts/record-skyscanner-fixture.ts [YYYY-MM-DD]
//   引数省略時は実行日+30日。
//
// 重要: このスクリプトはtest/fixtures/skyscanner/cards.json・agency-rows.json
// (parse.tsのユニットテストが実際に読むCONSTRUCTED fixture)を一切書き換えない —
// 出力は必ずtest/fixtures/skyscanner/live/配下の別ファイルにする。Skyscannerは
// PerimeterX等のbot対策が強く、フレッシュな(温めていない)プロファイルでは高確度で
// ブロックされる想定(spec: EXPECTED)。ブロックされてもテストのGREEN/REDには
// 一切影響しない(parse.ts/index.tsのユニットテストはこのスクリプトの出力を
// 参照しない、CONSTRUCTED fixtureのみを使う)。
//
// 採取したセレクタ/ヒューリスティックが実DOMとずれていたら、まずこのスクリプト自体と
// src/sources/skyscanner/index.tsのwrapPage内(collectCards/collectAgencyRows/
// detectBlockOnPwPage)を直して再採取すること。

import { mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

const OUT = "test/fixtures/skyscanner/live";
mkdirSync(OUT, { recursive: true });

// 既定の永続プロファイル(gitignore対象)。実運用のSkyscannerBrowserSourceが使う
// user_data_dir=""解決先と同じ場所を使う —これによりこのスクリプトを繰り返し実行する
// ことでプロファイルが「温まって」いく想定(1回限りの採取ではこの効果は出ない)。
const PROFILE_DIR = ".skyscanner-profile";
const NAV_TIMEOUT_MS = 20_000;

// page.evaluate()に渡す関数本体はPlaywrightにソース文字列としてシリアライズされ、
// ブラウザ側の実document上で実行される。このリポジトリのtsconfigはDOM libを含めない
// ため、document等のDOM globalの型名は直接参照できない。実際に使う分だけの
// Minimal構造型を自前定義してanyを避ける(record-gf-fixture.tsと同じ規約)。
type MinimalElement = { innerText?: string };
type MinimalDocument = {
	querySelectorAll(selector: string): Iterable<MinimalElement>;
};

function addDaysUtc(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

const date =
	process.argv[2] ?? addDaysUtc(new Date().toISOString().slice(0, 10), 30);

function buildSearchUrl(
	origin: string,
	destination: string,
	ymd: string,
): string {
	const yymmdd = ymd.replace(/-/g, "").slice(2);
	const params = new URLSearchParams({
		adultsv2: "1",
		cabinclass: "economy",
		rtn: "0",
		currency: "JPY",
		market: "jp",
		locale: "ja-JP",
	});
	return `https://www.skyscanner.jp/transport/flights/${origin.toLowerCase()}/${destination.toLowerCase()}/${yymmdd}/?${params.toString()}`;
}

// headless(bundled) → headless(chrome channel) → headful(chrome channel) の順に試す。
// headless検出でブロックされる場合、実チャネル/headfulの方が通ることがある
// (record-gf-fixture.tsと同じ考え方)。永続コンテキストなのでBrowserではなく
// BrowserContextを返す(SkyscannerBrowserSourceの本番経路と同じlaunchPersistentContext)。
async function launch(): Promise<BrowserContext> {
	const attempts: Array<[string, () => Promise<BrowserContext>]> = [
		[
			"chromium headless (persistent)",
			() => chromium.launchPersistentContext(PROFILE_DIR, { headless: true }),
		],
		[
			"chrome channel headless (persistent)",
			() =>
				chromium.launchPersistentContext(PROFILE_DIR, {
					channel: "chrome",
					headless: true,
				}),
		],
		[
			"chrome channel headful (persistent)",
			() =>
				chromium.launchPersistentContext(PROFILE_DIR, {
					channel: "chrome",
					headless: false,
				}),
		],
	];
	let lastErr: unknown;
	for (const [label, attempt] of attempts) {
		try {
			const context = await attempt();
			console.log(`launched: ${label}`);
			return context;
		} catch (err) {
			console.log(`launch failed (${label}): ${(err as Error).message}`);
			lastErr = err;
		}
	}
	throw lastErr;
}

async function dismissConsent(page: Page): Promise<void> {
	const labels = [/すべて同意/, /同意する/, /I agree/i, /Accept all/i];
	for (const label of labels) {
		try {
			await page
				.getByRole("button", { name: label })
				.first()
				.click({ timeout: 3000 });
			await page.waitForTimeout(500);
			console.log(`dismissed consent via label: ${label}`);
			return;
		} catch {
			// 次のラベルを試す
		}
	}
}

const BLOCK_TEXT_PATTERNS = [
	/perimeterx/i,
	/press\s*(?:&|and)\s*hold/i,
	/captcha/i,
	/通常と異なるトラフィック/,
	/unusual traffic/i,
	/are you a robot/i,
	/verify you are human/i,
];

async function detectBlock(page: Page): Promise<string | undefined> {
	const [title, html] = await Promise.all([
		page.title().catch(() => ""),
		page.content().catch(() => ""),
	]);
	const haystack = `${title}\n${html}`;
	for (const re of BLOCK_TEXT_PATTERNS) {
		if (re.test(haystack)) return re.source;
	}
	return undefined;
}

async function main(): Promise<void> {
	console.log(`skyscanner fixture capture (BEST-EFFORT): NRT->BKK ${date}`);
	console.log(
		"NOTE: test/fixtures/skyscanner/{cards,agency-rows}.json (CONSTRUCTED, used by unit tests) are never touched by this script.",
	);
	let context: BrowserContext | undefined;
	let outcome: "REAL" | "BLOCKED" | "LAUNCH_FAILED" = "BLOCKED";
	try {
		context = await launch();
		const page = await context.newPage();
		page.setDefaultTimeout(NAV_TIMEOUT_MS);

		const url = buildSearchUrl("NRT", "BKK", date);
		console.log(`navigating: ${url}`);
		await page.goto(url, { timeout: NAV_TIMEOUT_MS }).catch((err) => {
			console.log(`goto failed/timed out: ${(err as Error).message}`);
		});
		await dismissConsent(page);
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(3000);
		await Bun.write(`${OUT}/page.html`, await page.content());

		const blockReason = await detectBlock(page);
		if (blockReason) {
			console.log(`BLOCKED: detected block signal matching /${blockReason}/`);
		}

		// ---- カード(検索結果一覧)のベストエフォート抽出 ----
		const cards = await page.evaluate(() => {
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
				const transfersText = /直行|nonstop|direct/i.test(text) ? "直行" : text;
				out.push({
					airlineText: text.replace(priceMatch[0], "").trim().slice(0, 60),
					transfersText,
					priceText: priceMatch[0],
					departTimeText: timeMatch?.[0],
				});
			}
			return out;
		});
		await Bun.write(`${OUT}/cards.json`, JSON.stringify(cards, null, 2));
		console.log(`cards collected: ${cards.length}`);

		// ---- agency一覧(先頭カードをクリックして開く)のベストエフォート抽出 ----
		let agencyRows: {
			agency: string;
			priceText: string;
			badgeText?: string;
		}[] = [];
		if (!blockReason && cards.length > 0) {
			try {
				await page.click('[data-testid*="itinerary"]', { timeout: 5000 });
				await page.waitForTimeout(1500);
				await Bun.write(`${OUT}/agency-panel.html`, await page.content());
				agencyRows = await page.evaluate(() => {
					const doc = (globalThis as unknown as { document: MinimalDocument })
						.document;
					const priceRe = /[¥￥]\s*[\d,]+|[\d,]+\s*円/;
					const badgeRe = /recommended|おすすめ|信頼できる/i;
					const out: {
						agency: string;
						priceText: string;
						badgeText?: string;
					}[] = [];
					const candidates = Array.from(
						doc.querySelectorAll('[data-testid*="provider"], li, tr'),
					);
					for (const el of candidates) {
						const text = el.innerText?.trim() ?? "";
						if (!text || text.length > 200) continue;
						const priceMatch = text.match(priceRe);
						if (!priceMatch) continue;
						const agency = text.replace(priceMatch[0], "").trim();
						if (!agency) continue;
						out.push({
							agency,
							priceText: priceMatch[0],
							badgeText: badgeRe.test(text) ? text : undefined,
						});
					}
					return out;
				});
			} catch (err) {
				console.log(
					`agency panel click/extract failed: ${(err as Error).message}`,
				);
			}
		}
		await Bun.write(
			`${OUT}/agency-rows.json`,
			JSON.stringify(agencyRows, null, 2),
		);
		console.log(`agency-rows collected: ${agencyRows.length}`);

		outcome =
			!blockReason && (cards.length > 0 || agencyRows.length > 0)
				? "REAL"
				: "BLOCKED";
	} catch (err) {
		console.log(`capture failed: ${(err as Error).message}`);
		outcome = context ? "BLOCKED" : "LAUNCH_FAILED";
	} finally {
		await context?.close();
	}

	await Bun.write(
		`${OUT}/result.txt`,
		`outcome=${outcome}\ndate=${date}\ncapturedAt=${new Date().toISOString()}\n`,
	);
	console.log(`outcome: ${outcome}`);
	console.log(`saved fixtures to ${OUT}`);
}

await main();

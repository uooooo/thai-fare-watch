#!/usr/bin/env bun
// Google Flights(ja-JP)からNRT→BKKの実DOM aria-label/textを採取し、
// test/fixtures/gf/{result-rows.json, grid-labels.json, booking-rows.json} に保存する。
// 目視確認用に results.html / grid.html / booking.html も併せて保存する。
//
// Usage: bun run scripts/record-gf-fixture.ts [YYYY-MM-DD]
//   引数省略時は実行日+30日。
//
// Google Flightsはheadless検出/CAPTCHA/コンセント壁を出すことがある —
// 失敗時は空/ほぼ空のJSONが書かれるので、必ず目視で確認すること
// (src/sources/gf-browser/parse.tsのテストはこのスクリプトの出力を直接fixtureとして使う)。
// 採取したlocatorが実DOMとずれていたらこのスクリプト自体をまず直して再採取すること。

import { mkdirSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

const OUT = "test/fixtures/gf";
mkdirSync(OUT, { recursive: true });

// page.evaluate()に渡す関数本体はPlaywrightにソース文字列としてシリアライズされ、
// ブラウザ側の実document上で実行される。このリポジトリのtsconfigはDOM libを含めない
// ため、document等のDOM globalの型名は直接参照できない。実際に使う分だけの
// Minimal構造型を自前定義してanyを避ける。
type MinimalElement = {
	getAttribute(name: string): string | null;
	click?: () => void;
	innerText?: string;
};
type MinimalDocument = {
	querySelectorAll(selector: string): Iterable<MinimalElement>;
	querySelector(selector: string): MinimalElement | null;
};
// 注意: page.evaluate()に渡す関数は文字列化されブラウザ側で再解釈されるため、
// この関数自身のような外側(Node/Bun側)のクロージャ変数・関数は参照できない。
// 各evaluateコールバックの中で`(globalThis as unknown as {document: MinimalDocument}).document`
// を毎回その場で書く(このヘルパー自体をコールバック内から呼び出さないこと)。

function addDaysUtc(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

const date =
	process.argv[2] ?? addDaysUtc(new Date().toISOString().slice(0, 10), 30);

// headless(bundled) → headless(chrome channel) → headful(chrome channel) の順に試す。
// headless検出でブロックされる場合、実チャネル/headfulの方が通ることがある。
async function launch(): Promise<Browser> {
	const attempts: Array<[string, () => Promise<Browser>]> = [
		["chromium headless", () => chromium.launch({ headless: true })],
		[
			"chrome channel headless",
			() => chromium.launch({ channel: "chrome", headless: true }),
		],
		[
			"chrome channel headful",
			() => chromium.launch({ channel: "chrome", headless: false }),
		],
	];
	let lastErr: unknown;
	for (const [label, attempt] of attempts) {
		try {
			const browser = await attempt();
			console.log(`launched: ${label}`);
			return browser;
		} catch (err) {
			console.log(`launch failed (${label}): ${(err as Error).message}`);
			lastErr = err;
		}
	}
	throw lastErr;
}

// コンセント/クッキー壁のaccept-allボタンをベストエフォートで押す。見つからなければ無視。
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

async function main(): Promise<void> {
	console.log(`gf-browser fixture capture: NRT->BKK ${date}`);
	const browser = await launch();
	try {
		const page = await browser.newPage({ locale: "ja-JP" });
		page.setDefaultTimeout(20000);

		// ---- 1. 検索結果 ----
		const query = `NRT to BKK on ${date} one way`;
		const params = new URLSearchParams({
			hl: "ja",
			gl: "jp",
			curr: "JPY",
			q: query,
		});
		await page.goto(
			`https://www.google.com/travel/flights?${params.toString()}`,
		);
		await dismissConsent(page);
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(3000);
		await Bun.write(`${OUT}/results.html`, await page.content());

		// evaluate内はブラウザ側で実行される(このリポジトリのtsconfigはDOM libを含めない
		// ため、document等はglobalThis経由でMinimalDocument/MinimalElementとして触る)。
		const resultRows: string[] = await page.evaluate(() => {
			const doc = (globalThis as unknown as { document: MinimalDocument })
				.document;
			return Array.from(doc.querySelectorAll("[aria-label]"))
				.map((el) => el.getAttribute("aria-label") ?? "")
				.filter(
					(label: string) => /発.*着/.test(label) && /[¥￥]|円/.test(label),
				);
		});
		await Bun.write(
			`${OUT}/result-rows.json`,
			JSON.stringify(resultRows, null, 2),
		);
		console.log(`result-rows collected: ${resultRows.length}`);

		// ---- 2. 日付グリッド ----
		try {
			await page
				.getByRole("button", { name: /日付/ })
				.first()
				.click({ timeout: 5000 });
			await page.waitForTimeout(2000);
		} catch (err) {
			console.log(
				`date-grid button not found/clickable: ${(err as Error).message}`,
			);
		}
		await Bun.write(`${OUT}/grid.html`, await page.content());
		const gridLabels: string[] = await page.evaluate(() => {
			const doc = (globalThis as unknown as { document: MinimalDocument })
				.document;
			return Array.from(doc.querySelectorAll("[aria-label]"))
				.map((el) => el.getAttribute("aria-label") ?? "")
				.filter((label: string) => /\d+月\d+日/.test(label));
		});
		await Bun.write(
			`${OUT}/grid-labels.json`,
			JSON.stringify(gridLabels, null, 2),
		);
		console.log(`grid-labels collected: ${gridLabels.length}`);
		await page.keyboard.press("Escape").catch(() => {});

		// ---- 3. 予約オプション(先頭/最安の結果行をクリック) ----
		const bookingRows: { sellerText: string; priceText: string }[] = [];
		const firstRow = resultRows[0];
		if (firstRow) {
			try {
				// 通常のPlaywright click()はサインインバナー等のオーバーレイに
				// pointer-eventsをインターセプトされて失敗することがあるため、
				// 実DOMのel.click()を直接呼ぶ(actionability検査を回避するフォールバック)。
				const clicked: boolean = await page.evaluate((label: string) => {
					const doc = (globalThis as unknown as { document: MinimalDocument })
						.document;
					const el = doc.querySelector(
						`[aria-label="${label.replace(/"/g, '\\"')}"]`,
					);
					el?.click?.();
					return Boolean(el);
				}, firstRow);
				if (!clicked) throw new Error("result row element not found for click");
				await page.waitForTimeout(3000);
				await Bun.write(`${OUT}/booking.html`, await page.content());
				const rows: { sellerText: string; priceText: string }[] =
					await page.evaluate(() => {
						const doc = (globalThis as unknown as { document: MinimalDocument })
							.document;
						const out: { sellerText: string; priceText: string }[] = [];
						const priceRe = /[¥￥]\s*[\d,]+|[\d,]+\s*円/;
						const candidates = Array.from(
							doc.querySelectorAll('li, tr, div[role="listitem"]'),
						);
						for (const el of candidates) {
							const text = el.innerText?.trim() ?? "";
							if (!text || text.length > 200) continue;
							const m = text.match(priceRe);
							if (!m) continue;
							const priceText = m[0];
							const sellerText = text.replace(priceText, "").trim();
							if (sellerText) out.push({ sellerText, priceText });
						}
						return out;
					});
				bookingRows.push(...rows);
			} catch (err) {
				console.log(`booking-options click failed: ${(err as Error).message}`);
			}
		}
		await Bun.write(
			`${OUT}/booking-rows.json`,
			JSON.stringify(bookingRows, null, 2),
		);
		console.log(`booking-rows collected: ${bookingRows.length}`);
	} finally {
		await browser.close();
	}
	console.log(`saved fixtures to ${OUT}`);
}

await main();

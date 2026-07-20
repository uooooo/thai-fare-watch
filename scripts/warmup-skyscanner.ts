// Skyscannerの永続プロファイルwarmupツール。
// 実Chrome(channel:chrome)を .skyscanner-profile/ の永続コンテキストで「画面に表示して」開き、
// 人間がPerimeterXのpress-and-hold CAPTCHAを解く→普通に閲覧することで _px 系トークンを
// プロファイルに蓄積させる。以後 SkyscannerBrowserSource が同じプロファイルを再利用する。
//
// 使い方: bun run scripts/warmup-skyscanner.ts [origin] [destination] [YYYY-MM-DD]
// 既定: nrt bkk (今日から約30日後)
//
// 画面にChromeが開いたら:
//  1. 「押し続けてください/press & hold」等のCAPTCHAが出たら指示どおり解く
//  2. 検索結果(¥価格)が表示されるまで待つ。出たら本スクリプトが自動で成功検知して閉じる
//  3. 数分待っても解けない/結果が出ない場合はそのまま放置(タイムアウトで終了、蓄積分は保存)
import { chromium } from "playwright";

const PROFILE_DIR = ".skyscanner-profile";
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 8 * 60 * 1000;

function addDays(date: Date, days: number): string {
	const d = new Date(date.getTime() + days * 86_400_000);
	return d.toISOString().slice(0, 10);
}

const origin = (process.argv[2] ?? "nrt").toLowerCase();
const destination = (process.argv[3] ?? "bkk").toLowerCase();
const date = process.argv[4] ?? addDays(new Date(), 30);
const yymmdd = date.replace(/-/g, "").slice(2);
const params = new URLSearchParams({
	adultsv2: "1",
	cabinclass: "economy",
	rtn: "0",
	currency: "JPY",
	market: "jp",
	locale: "ja-JP",
});
const url = `https://www.skyscanner.jp/transport/flights/${origin}/${destination}/${yymmdd}/?${params.toString()}`;

const BLOCK_RE = /px-captcha|captcha|通常と異なるトラフィック|press.*hold|押し(続|し続)|human/i;

console.log(`warmup: opening real Chrome (visible) with profile ${PROFILE_DIR}`);
console.log(`warmup: ${origin.toUpperCase()} -> ${destination.toUpperCase()} ${date}`);
console.log(`warmup: ${url}`);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
	channel: "chrome",
	headless: false,
	locale: "ja-JP",
	viewport: null,
	args: ["--start-maximized"],
});

const page = context.pages()[0] ?? (await context.newPage());
try {
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
} catch (e) {
	console.log(`warmup: initial goto warning: ${(e as Error).message}`);
}

const started = Date.now();
let outcome: "success" | "timeout" = "timeout";
while (Date.now() - started < MAX_WAIT_MS) {
	await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	let html = "";
	let title = "";
	try {
		html = (await page.content()).toLowerCase();
		title = (await page.title()).toLowerCase();
	} catch {
		// ページ遷移中などは次のpollへ
		continue;
	}
	const blocked = BLOCK_RE.test(html);
	const hasPrices = /[¥￥]\s*[\d,]/.test(html);
	const elapsed = Math.round((Date.now() - started) / 1000);
	console.log(
		`warmup: +${elapsed}s title="${title.slice(0, 40)}" blocked=${blocked} prices=${hasPrices}`,
	);
	if (!blocked && hasPrices) {
		outcome = "success";
		break;
	}
}

if (outcome === "success") {
	console.log("warmup: WARMUP_SUCCESS — 結果が表示されました。数秒後に保存して閉じます。");
	await new Promise((r) => setTimeout(r, 5000));
} else {
	console.log(
		"warmup: WARMUP_TIMEOUT — 時間内に結果を検知できませんでした(蓄積分のクッキーは保存されます)。",
	);
}

await context.close();
console.log(`warmup: done (${outcome}). profile saved at ${PROFILE_DIR}`);
process.exit(outcome === "success" ? 0 : 2);

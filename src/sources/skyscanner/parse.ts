import type { FareObservation } from "../../types";
import { parsePriceJpy } from "../gf-browser/parse";

// gf-browser/parse.tsのparsePriceJpyをそのまま再利用する(重複実装によるdriftを避ける
// —Deliverable 3の指示通り「importを優先」)。skyscanner配下のimport元をこの1箇所に
// 揃えるため、そのまま再exportもしておく(テスト/呼び出し側は"./parse"だけを見ればよい)。
export { parsePriceJpy };

// Skyscanner(ja-JP)の検索結果ページ/agency一覧モーダルから採取した"構造化済み"の行データ
// (DOM要素ごとに個別テキストを読んだ後の形)を解釈する純関数群。Google Flights(aria-labelの
// 1文をまるごと正規表現で分解するgf-browser方式)とは異なり、Skyscannerの実DOMは価格/
// 航空会社名/経由数/agency名/バッジがそれぞれ別要素に分かれている想定のため、ブラウザ層
// (index.ts)側で要素ごとに読み取った後の{フィールド}をそのまま受け取る形にしてある。
// ブラウザを一切起動しない(fixtureテスト対象)。パース不能な入力は例外を投げず、その1件だけ
// を結果から除外する(呼び出し側のsweep/verifyループを止めないため)。

// 検索結果は1つのorigin/destination/departDateに固定されたページなので、カード自体の
// DOM上にはこれらが繰り返し表示されない想定 — ブラウザ層(index.ts)が検索コンテキストから
// 既知の値をrowへ注入してから渡す(departDateはgf-browserのRowRaw.departDateと同じ考え方)。
export type SkyscannerCardRaw = {
	origin: string;
	destination: string;
	departDate: string;
	airlineText: string;
	transfersText: string;
	priceText: string;
	// 一覧カードによっては(まとめ表示・価格未確定行等で)出発時刻が表示されないことがある
	// ため任意。無ければdepartAtはundefinedのまま他フィールドだけを返す。
	departTimeText?: string;
};

export type AgencyRowRaw = {
	agency: string;
	priceText: string;
	// 「おすすめの提供会社」等のバッジのDOM上の生テキスト。バッジ自体が存在しない行はundefined。
	badgeText?: string;
};

type ParsedCard = Omit<FareObservation, "id" | "source" | "market" | "foundAt">;
export type ParsedAgencyRow = {
	seller: string;
	priceJpy: number;
	recommendedBadge: boolean;
};

function pad2(n: number | string): string {
	return String(n).padStart(2, "0");
}

// "直行" → 0。"経由1回"/"乗り継ぎ2回"/"1 stop"/"2 stops"(英語UIフォールバック) → 回数。
// どちらにも該当しなければundefined(呼び出し側がその行をスキップする)。
const STOPS_RE = /(\d+)\s*(?:回|stop)/i;
function parseTransfers(text: string): number | undefined {
	if (/直行/.test(text)) return 0;
	const m = text.match(STOPS_RE);
	if (!m?.[1]) return undefined;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : undefined;
}

// "17:05" のような24時制の時刻文字列をdepartDateと組み合わせてISO8601(オフセット無し
// 現地時刻)にする。時刻テキストが無い/パースできない場合はundefinedを返す(gf-browserの
// resolveArriveDateと異なり、Skyscannerのカード一覧は到着時刻を出さないためarriveAtは扱わない)。
const TIME_RE = /(\d{1,2}):(\d{2})/;
function parseDepartAt(
	departDate: string,
	timeText: string | undefined,
): string | undefined {
	if (!timeText) return undefined;
	const m = timeText.match(TIME_RE);
	if (!m?.[1] || !m[2]) return undefined;
	return `${departDate}T${pad2(m[1])}:${m[2]}:00`;
}

// Skyscannerのフェアカード群 → FareObservation片(id/source/market/foundAtはブラウザ層が
// 付与する)。価格・航空会社名・経由数のいずれかが読み取れない行は個別にスキップする
// (1行のパース失敗で他の行まで捨てない)。出発時刻は「あれば含める」— 無くても他の
// フィールドが揃っていれば行自体は活かす(spec: "depart time if present")。
export function parseSkyscannerCards(rows: SkyscannerCardRaw[]): ParsedCard[] {
	const out: ParsedCard[] = [];
	for (const row of rows) {
		const priceJpy = parsePriceJpy(row.priceText ?? "");
		if (priceJpy === undefined) continue;

		const airline = (row.airlineText ?? "").trim();
		if (!airline) continue;

		const transfers = parseTransfers(row.transfersText ?? "");
		if (transfers === undefined) continue;

		const departAt = parseDepartAt(row.departDate, row.departTimeText);

		out.push({
			origin: row.origin,
			destination: row.destination,
			departDate: row.departDate,
			...(departAt !== undefined ? { departAt } : {}),
			airline,
			transfers,
			priceJpy,
		});
	}
	return out;
}

// バッジのDOM生テキストに「おすすめ/Recommended/信頼できる」を含むかどうかの判定。
// 完全一致ではなく部分一致(正規表現)でよい —これはtrust.tsの販売元名なりすまし対策
// (完全一致のみ)とは別の関心事: ここで決めるのはあくまで「Skyscannerが画面上にどういう
// 文言のバッジを出したか」というプレゼンテーション層の解釈であり、判定結果は単なる
// booleanとしてtrust.ts(classifySeller)へ渡るだけなので、trust.ts側の完全一致不変条件
// を弱めない。
const RECOMMENDED_BADGE_RE = /recommended|おすすめ|信頼できる/i;

function hasRecommendedBadge(badgeText: string | undefined): boolean {
	return badgeText !== undefined && RECOMMENDED_BADGE_RE.test(badgeText);
}

// agency一覧(予約オプション)の行群 → {seller, priceJpy, recommendedBadge}[]。
// agency名または価格が読み取れない行は個別にスキップする。
export function parseAgencyRows(rows: AgencyRowRaw[]): ParsedAgencyRow[] {
	const out: ParsedAgencyRow[] = [];
	for (const row of rows) {
		const seller = (row.agency ?? "").trim();
		const priceJpy = parsePriceJpy(row.priceText ?? "");
		if (!seller || priceJpy === undefined) continue;
		out.push({
			seller,
			priceJpy,
			recommendedBadge: hasRecommendedBadge(row.badgeText),
		});
	}
	return out;
}

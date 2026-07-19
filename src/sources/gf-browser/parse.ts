import type { FareObservation } from "../../types";

// Google Flights(ja-JP)のDOMから採取した文字列(aria-label/innerText)を解釈する純関数群。
// ブラウザを一切起動しない(fixtureテスト対象)。パース不能な入力は例外を投げず、
// その1件だけを結果から除外する(呼び出し側のsweep/verifyループを止めないため)。

export type GridCell = { date: string; priceJpy: number };
export type RowRaw = { ariaLabel: string; departDate: string };
export type BookingRow = { sellerText: string; priceText: string };

// "¥14,980" / "14,980円" / "36072 円～"(先頭の値のみ) → 14980。
// 桁区切りカンマの有無・全角/半角¥のどちらにも対応。数字+(¥|円)の組が無ければundefined。
const PRICE_RE = /[¥￥]\s*([\d,]+)|([\d,]+)\s*円/;

export function parsePriceJpy(text: string): number | undefined {
	const m = text.match(PRICE_RE);
	if (!m) return undefined;
	const raw = m[1] ?? m[2];
	if (!raw) return undefined;
	const n = Number(raw.replace(/,/g, ""));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 日付グリッドのセルaria-label例: "8月2日 土曜日、14,980円" / 価格無し: "8月5日 火曜日、価格情報なし"。
const GRID_DATE_RE = /(\d{1,2})月\s*(\d{1,2})日/;

function pad2(n: number | string): string {
	return String(n).padStart(2, "0");
}

// labelsは表示順(月が単調増加し、年をまたぐ箇所でのみ減少する)を前提にする。
// yearは最初のラベルの年。月が前セルより小さくなった時点(12月→1月等)でyearを+1する。
// 価格情報なしセルもロールオーバー追跡のためprevMonthは更新するが、出力には含めない。
export function parseGridAria(labels: string[], year: number): GridCell[] {
	const out: GridCell[] = [];
	let currentYear = year;
	let prevMonth: number | undefined;

	for (const label of labels) {
		const m = label.match(GRID_DATE_RE);
		if (!m?.[1] || !m[2]) continue;
		const month = Number(m[1]);
		const day = Number(m[2]);
		if (prevMonth !== undefined && month < prevMonth) currentYear += 1;
		prevMonth = month;

		const priceJpy = parsePriceJpy(label);
		if (priceJpy === undefined) continue; // 「価格情報なし」等は除外

		out.push({ date: `${currentYear}-${pad2(month)}-${pad2(day)}`, priceJpy });
	}
	return out;
}

// 結果行aria-label(実キャプチャ形式、2026-07実機確認)例:
// "36072 円～。 ZIPAIR Tokyo が運航する直行便。 火曜日, 8月 18 17:00 成田国際空港発、
//  火曜日, 8月 18 21:40 スワンナプーム国際空港着。 合計時間 6時間 40分。   フライトを選択"
// 経由便: "…が運航する経由地 1 か所のフライト。…"。コードシェア注記("航空会社: Air Japan.")等の
// 追加セグメントが発着セグメントの前に挟まることがあるが、正規表現は非アンカーなので無視できる。
const DEPART_ARRIVE_RE =
	/(\d{1,2})月\s*(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(.+?)発、(?:.*?,\s*)?(\d{1,2})月\s*(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(.+?)着/;

// 空港の日本語表示名 → IATAコード(cfg.origins/positioning/hubs/destinationsで実際に使う範囲)。
// 未知の名称は解決できず該当行はスキップする(誤ったコードを下流に流さないため)。
const AIRPORT_CODE_BY_NAME: Record<string, string> = {
	成田国際空港: "NRT",
	羽田空港: "HND",
	東京国際空港: "HND",
	関西国際空港: "KIX",
	大阪国際空港: "ITM",
	中部国際空港: "NGO",
	福岡空港: "FUK",
	那覇空港: "OKA",
	スワンナプーム国際空港: "BKK",
	ドンムアン国際空港: "DMK",
	チェンマイ国際空港: "CNX",
	プーケット国際空港: "HKT",
	仁川国際空港: "ICN",
	金浦国際空港: "GMP",
	台湾桃園国際空港: "TPE",
	桃園国際空港: "TPE",
	クアラルンプール国際空港: "KUL",
	タンソンニャット国際空港: "SGN",
	チャンギ国際空港: "SIN",
	"シンガポール・チャンギ国際空港": "SIN",
	香港国際空港: "HKG",
	"ニノイ・アキノ国際空港": "MNL",
};

function airportCode(name: string): string | undefined {
	const trimmed = name.trim();
	if (AIRPORT_CODE_BY_NAME[trimmed]) return AIRPORT_CODE_BY_NAME[trimmed];
	// 稀に名称に(IATA)コードが括弧書きされることがあるためフォールバックで拾う。
	const m = trimmed.match(/[（(]([A-Z]{3})[）)]/);
	return m?.[1];
}

// departDate(YYYY-MM-DD)の月を基準に、到着月がそれより小さければ年をまたいだとみなす
// (例: 出発12/30・到着1/1 → 到着年は出発年+1)。同月・同年内で先の月ならそのまま。
function resolveArriveDate(
	departDate: string,
	arriveMonth: number,
	arriveDay: number,
): string {
	const departYear = Number(departDate.slice(0, 4));
	const departMonth = Number(departDate.slice(5, 7));
	const year = arriveMonth < departMonth ? departYear + 1 : departYear;
	return `${year}-${pad2(arriveMonth)}-${pad2(arriveDay)}`;
}

type ParsedResultRow = Omit<
	FareObservation,
	"id" | "source" | "market" | "foundAt"
>;

function parseResultRow(row: RowRaw): ParsedResultRow | undefined {
	const { ariaLabel, departDate } = row;
	const priceJpy = parsePriceJpy(ariaLabel);
	if (priceJpy === undefined) return undefined;

	const segments = ariaLabel
		.split("。")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	// 運航会社+直行/経由は同一セグメント("Xが運航するY")にまとまっている。
	const airlineSeg = segments.find((s) => s.includes("が運航する"));
	if (!airlineSeg) return undefined;
	const airlineMatch = airlineSeg.match(/^(.+?)\s*が運航する\s*(.+)$/);
	if (!airlineMatch) return undefined;
	const airline = airlineMatch[1]?.trim();
	const directness = airlineMatch[2] ?? "";
	if (!airline) return undefined;

	let transfers: number | undefined;
	if (/直行/.test(directness)) {
		transfers = 0;
	} else {
		const stops =
			directness.match(/経由地\s*(\d+)\s*か所/) ??
			directness.match(/乗り継ぎ\s*(\d+)\s*回/);
		if (stops?.[1]) transfers = Number(stops[1]);
	}
	if (transfers === undefined) return undefined;

	// 発着セグメントはコードシェア注記等の前置きを含むことがあるので、
	// "発"と"着"を両方含むセグメントを内容ベースで探す(位置に依存しない)。
	const routeSeg = segments.find((s) => s.includes("発") && s.includes("着"));
	if (!routeSeg) return undefined;
	const routeMatch = routeSeg.match(DEPART_ARRIVE_RE);
	if (!routeMatch) return undefined;
	const [
		,
		,
		,
		departHour,
		departMin,
		originNameRaw,
		arriveMonthRaw,
		arriveDayRaw,
		arriveHour,
		arriveMin,
		destNameRaw,
	] = routeMatch;
	if (
		!departHour ||
		!departMin ||
		!originNameRaw ||
		!arriveMonthRaw ||
		!arriveDayRaw ||
		!arriveHour ||
		!arriveMin ||
		!destNameRaw
	) {
		return undefined;
	}

	const origin = airportCode(originNameRaw);
	const destination = airportCode(destNameRaw);
	if (!origin || !destination) return undefined;

	const departAt = `${departDate}T${pad2(departHour)}:${departMin}:00`;
	const arriveDate = resolveArriveDate(
		departDate,
		Number(arriveMonthRaw),
		Number(arriveDayRaw),
	);
	const arriveAt = `${arriveDate}T${pad2(arriveHour)}:${arriveMin}:00`;

	return {
		origin,
		destination,
		departDate,
		departAt,
		arriveAt,
		airline,
		transfers,
		priceJpy,
	};
}

export function parseResultRows(rows: RowRaw[]): ParsedResultRow[] {
	const out: ParsedResultRow[] = [];
	for (const row of rows) {
		const parsed = parseResultRow(row);
		if (parsed) out.push(parsed);
	}
	return out;
}

// 予約オプション行の生aria-label(実キャプチャ形式)例:
// "航空会社 ZIPAIR Tokyo での予約手続きに進む（料金: 36072 円）"
// OTA名には「航空会社」接頭辞が付かない(例: "Trip.com での予約手続きに進む（料金: 15100 円）")。
// 末尾に外貨換算の注記が付くことがあるが、価格は括弧内の最初の"…円"で確定するため無視できる。
const BOOKING_ARIA_RE =
	/^(?:航空会社|販売会社)?\s*(.+?)\s*での予約手続きに進む.*?[（(]料金[:：]\s*([\d,]+)\s*円/;

// ブラウザ層(index.ts)がDOM上のaria-label文字列を{sellerText, priceText}へ分解する際に
// 使う純関数。parseBookingRowsの4シグネチャ("Deliverables"記載の必須API)には含まれない
// 追加のヘルパーだが、実キャプチャで判明した予約オプションのDOM形状(seller名と価格が
// 1つのaria-labelに結合されている)に対応するため、pure/testableな形でここに切り出した。
export function parseBookingAria(
	raw: string,
): { sellerText: string; priceText: string } | undefined {
	const m = raw.match(BOOKING_ARIA_RE);
	if (!m) return undefined;
	const sellerText = m[1]?.trim();
	const priceDigits = m[2];
	if (!sellerText || !priceDigits) return undefined;
	return { sellerText, priceText: `${priceDigits}円` };
}

export function parseBookingRows(
	rows: BookingRow[],
): { seller: string; priceJpy: number }[] {
	const out: { seller: string; priceJpy: number }[] = [];
	for (const row of rows) {
		const seller = row.sellerText.trim();
		const priceJpy = parsePriceJpy(row.priceText);
		if (!seller || priceJpy === undefined) continue;
		out.push({ seller, priceJpy });
	}
	return out;
}

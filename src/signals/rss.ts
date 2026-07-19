import { XMLParser } from "fast-xml-parser";
import type { Config, FeedConf } from "../config";
import type { SaleNews } from "../types";
import { fetchText } from "../util/http";

const MAX_SEEN = 200;

// RSS2 (WordPress想定) をfast-xml-parserでignoreAttributes:false指定で読んだ形状。
// テキストと属性を両方持つ要素（例: <guid isPermaLink="...">）は
// { "#text": ..., "@_isPermaLink": ... } のオブジェクトになる。単純要素（属性無し）は
// プリミティブ値（大半はstring。strnumにより数値化される場合はnumberもあり得る）。
type RssTextNode = string | number | { "#text"?: string | number };
type RssItemXml = {
	title?: string | number;
	link?: string | number;
	guid?: RssTextNode;
	pubDate?: string;
};
type RssFeedXml = {
	rss?: { channel?: { item?: RssItemXml | RssItemXml[] } };
};

// Rule B（airlines × context）の文脈語からは「セール」「片道」を除外する。
// 理由: 「セール」は国内線の特売でも高頻度に出る語で、航空会社名との併存だけでは
// 国際線シグナルとして弱すぎる（「タイムセール」のような複合語は末尾に「セール」を
// 含むが、独立した語として除外リストとは別に候補へ残る＝文字列除外ではなく
// 候補リストからの単語除外で実現する）。「片道」も国内線セールで広く使われ弁別力が
// 低いため同様に除外する。config自体（rss_keywords.context）は変更せず、
// フィルタはこのmatcher内でのみ行う。
const RULE_B_EXCLUDED_CONTEXT = new Set(["セール", "片道"]);

function includesAny(title: string, words: string[]): string[] {
	return words.filter((w) => title.includes(w));
}

// マッチしたキーワードを返す（空配列=不一致）。
// Rule A: placesのいずれかを含む → その語（複数可）を返す。
// Rule B: Rule Aが不一致の場合のみ判定。airlinesのいずれか かつ
//         （セール/片道を除いた）contextのいずれかを含む → 両方の語を返す。
export function matchSaleNews(
	title: string,
	kw: Config["rss_keywords"],
): string[] {
	const places = includesAny(title, kw.places);
	if (places.length > 0) return places;

	const airlines = includesAny(title, kw.airlines);
	if (airlines.length === 0) return [];

	const ruleBContext = kw.context.filter(
		(w) => !RULE_B_EXCLUDED_CONTEXT.has(w),
	);
	const context = includesAny(title, ruleBContext);
	if (context.length === 0) return [];

	return [...airlines, ...context];
}

function toArray<T>(v: T | T[] | undefined): T[] {
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

// guid = guid["#text"] ?? guid ?? link（文字列化）。
// guid要素が属性付き(オブジェクト化)/属性無し(プリミティブ)/欠落のいずれでも解決する。
function guidOf(item: RssItemXml): string {
	const g = item.guid;
	const text = typeof g === "object" && g !== null ? g["#text"] : undefined;
	return String(text ?? g ?? item.link);
}

export class RssSignal {
	private readonly cfg: Config;
	private readonly fetchImpl: typeof fetch;

	constructor(cfg: Config, deps: { fetchImpl?: typeof fetch } = {}) {
		this.cfg = cfg;
		this.fetchImpl = deps.fetchImpl ?? fetch;
	}

	async poll(
		feed: FeedConf,
		seenGuids: string[],
	): Promise<{ news: SaleNews[]; seen: string[] }> {
		const xml = await fetchText(feed.url, { fetchImpl: this.fetchImpl });
		const parser = new XMLParser({ ignoreAttributes: false });
		const parsed: RssFeedXml = parser.parse(xml);
		const items = toArray(parsed.rss?.channel?.item);

		const seen = new Set(seenGuids);
		const news: SaleNews[] = [];
		const newGuids: string[] = [];

		for (const item of items) {
			const guid = guidOf(item);
			if (seen.has(guid)) continue;

			const title = String(item.title ?? "");
			const matchedKeywords = matchSaleNews(title, this.cfg.rss_keywords);
			if (matchedKeywords.length === 0) continue;

			news.push({
				guid,
				feed: feed.name,
				title,
				url: String(item.link ?? ""),
				matchedKeywords,
				publishedAt: item.pubDate ?? "",
			});
			newGuids.push(guid);
			seen.add(guid); // 同一poll内の重複guidを二重登録しない
		}

		const merged = [...newGuids, ...seenGuids];
		const deduped = Array.from(new Set(merged));
		return { news, seen: deduped.slice(0, MAX_SEEN) };
	}
}

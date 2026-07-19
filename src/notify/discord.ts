import type {
	FareObservation,
	Itinerary,
	Leg,
	SaleNews,
	SellerOffer,
	SourceHealth,
	Tier,
	Verification,
} from "../types";
import { isGround } from "../types";
import { fetchText } from "../util/http";

const CHUNK_SIZE = 10;

const TIER_EMOJI: Record<Tier, string> = {
	flash: "💥",
	deal: "🔥",
	candidate: "⚠️",
};
const TIER_COLOR: Record<Tier, number> = {
	flash: 0xff2d55,
	deal: 0xff9500,
	candidate: 0x8e8e93,
};
const DEFAULT_COLOR = 0x0a84ff; // tier未定義のデフォルト色。buildNewsEmbedの色でもある。
const HEALTH_COLOR = 0xffcc00;
const GROUND_MODE_JA = { bus: "バス", train: "電車" } as const;

function yen(n: number): string {
	return `¥${n.toLocaleString("ja-JP")}`;
}

// "YYYY-MM-DD" → "M/D"（ゼロ埋め無し）
function monthDay(dateStr: string): string {
	const [, month, day] = /^\d{4}-(\d{2})-(\d{2})/.exec(dateStr) ?? [];
	return `${Number(month)}/${Number(day)}`;
}

// flightレグの origin → ... → destination。groundレグがあれば
// 「(バス/電車)from→to」形で先頭に付与する。
function routeSummary(legs: Leg[]): string {
	const groundPart = legs
		.filter(isGround)
		.map((g) => `(${GROUND_MODE_JA[g.mode]})${g.from}→${g.to}`)
		.join(" ");
	const flightLegs = legs.filter((l): l is FareObservation => !isGround(l));
	const first = flightLegs[0];
	const flightPart = first
		? [first.origin, ...flightLegs.map((l) => l.destination)].join(" → ")
		: "";
	return [groundPart, flightPart].filter(Boolean).join(" ");
}

// レグ内訳1行。flight: `便名/航空会社 ¥価格 (source/検証状態)`。
// ground: `モード from→to ¥価格`（itinerary全体の検証状態はground自体には付かないため付与しない）。
function legLine(l: Leg, verification: Verification): string {
	if (isGround(l)) {
		return `${GROUND_MODE_JA[l.mode]} ${l.from}→${l.to} ${yen(l.priceJpy)}`;
	}
	const name = [l.flightNumber, l.airline].filter(Boolean).join("/");
	return `${name} ${yen(l.priceJpy)} (${l.source}/${verification})`;
}

// Discord embed 1個。tier別の絵文字/色。descriptionは
// 経路→レグ内訳→fx手数料(任意)→risks→検証状態→予約先seller(任意)→Google Flights(任意)の順。
export function buildDealEmbed(
	it: Itinerary,
	opts?: { seller?: SellerOffer; gfUrl?: string },
): object {
	const tier = it.tier;
	const emoji = (tier && TIER_EMOJI[tier]) ?? "ℹ️";
	const color = (tier && TIER_COLOR[tier]) ?? DEFAULT_COLOR;

	const route = routeSummary(it.legs);
	const flightLegs = it.legs.filter((l): l is FareObservation => !isGround(l));
	const firstDate = flightLegs[0]?.departDate;
	const dateLabel = firstDate ? `${monthDay(firstDate)}発` : "";
	const title = [`${emoji} ${yen(it.totalJpy)}`, route, dateLabel]
		.filter(Boolean)
		.join(" ");

	const lines: string[] = [route];
	for (const l of it.legs) lines.push(legLine(l, it.verification));
	if (it.fxFeeJpy > 0) lines.push(`外貨手数料込み: +${yen(it.fxFeeJpy)}`);
	for (const risk of it.risks) lines.push(`⚠ ${risk}`);
	lines.push(`検証状態: ${it.verification}`);
	if (opts?.seller) {
		const s = opts.seller;
		const booking = s.bookingUrl ? ` ${s.bookingUrl}` : "";
		lines.push(`予約先: ${s.seller} ${yen(s.priceJpy)}${booking}`);
	}
	if (opts?.gfUrl) lines.push(`Google Flights: ${opts.gfUrl}`);

	return { title, description: lines.join("\n"), color };
}

// セール速報1件のDiscord embed。
export function buildNewsEmbed(n: SaleNews): object {
	return {
		title: `ℹ️ セール速報: ${n.title}`,
		url: n.url,
		description: `キーワード: ${n.matchedKeywords.join("・")} / フィード: ${n.feed}`,
		color: DEFAULT_COLOR,
	};
}

// ソース不調通知のDiscord embed。
export function buildHealthEmbed(source: string, h: SourceHealth): object {
	const detail = h.lastError ?? "(詳細不明)";
	return {
		title: `🩺 ${source} が不調です`,
		description: `${detail} (連続${h.consecutiveFailures}回失敗)`,
		color: HEALTH_COLOR,
	};
}

// Discord webhook送信。最大10embed/回でchunkし、順にPOSTする。
//
// 成功判定・リトライ・バックオフはutil/http.tsのfetchTextに委譲する（自前実装しない）:
// fetchTextは内部でres.ok（2xx全般、204 No Contentも含む）を成功とし、429/5xxのみ既定3回
// リトライ（指数バックオフ）、それ以外の失敗ステータス/ネットワーク例外は即throwする。
// fetchJsonではなくfetchTextを選ぶ理由: Discordはwait=true成功時に200(JSON本文あり)を返すが
// 204(本文無し)を返す実装もあり得るため、`.json()`前提のfetchJsonだと204で例外になりかねない。
// fetchTextは`.text()`のみでレスポンス種別に依存せず安全。POST本文/戻り値自体は使わないため
// 戻り値は捨てる。
export class DiscordNotifier {
	private readonly webhookUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(webhookUrl: string, deps: { fetchImpl?: typeof fetch } = {}) {
		this.webhookUrl = webhookUrl;
		this.fetchImpl = deps.fetchImpl ?? fetch;
	}

	async send(embeds: object[]): Promise<void> {
		for (let i = 0; i < embeds.length; i += CHUNK_SIZE) {
			const chunk = embeds.slice(i, i + CHUNK_SIZE);
			await fetchText(`${this.webhookUrl}?wait=true`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ embeds: chunk }),
				fetchImpl: this.fetchImpl,
			});
		}
	}
}

import type { SellerOffer, VerifiedOffer } from "../types";

// 末尾（接尾辞）／先頭（接頭辞）の定型句除去パターン。lowercase化した後・記号除去前に
// 一度だけ剥がす。
const SUFFIX_RE = /(で予約|にて予約)$/;
const PREFIX_RE = /^book with /;

// Unicode NFKC → 小文字化 → 定型句除去 → [a-z0-9]以外を全除去。
// 日本語のみの販売元名（旅行会社の和名等）はこの最終ステップで空文字になる
// （英数字を1文字も含まないため）。これは意図した挙動であり、呼び出し側は
// 空文字を「何にもマッチしない」ものとして明示的にガードする（後述）。
export function normalizeSeller(name: string): string {
	const lower = name.normalize("NFKC").toLowerCase();
	const noSuffix = lower.replace(SUFFIX_RE, "");
	const noPrefix = noSuffix.replace(PREFIX_RE, "");
	return noPrefix.replace(/[^a-z0-9]/g, "");
}

// 正規化済み文字列どうしの「完全一致」判定。どちらかが空文字なら常にfalseとする。
// GUARD: ガードなしだと"" === "" === trueとなり、CJKのみの販売元名がCJKのみの
// 運航会社名/OTA名と（内容と無関係に）無条件で一致してしまう。
//
// 部分一致・前方一致は採用しない。過去に採用した際、いずれも実際のなりすまし経路として
// 顕在化したため（Adversarial review findings）:
// - 包含(contains)判定だった当時: seller "ZIP"/"Air"/"Thai"/"Z" が legAirlines
//   "ZIPAIR"/"Thai AirAsia X" 側にcontainsされることでairlineに誤判定された
//   （短い部分文字列でのなりすまし。この経路は全ルートで航空会社名が頻出するため危険度が高い）。
// - 前方一致(startsWith)判定だった当時: seller "trip.com.evil-agency" が正規化後
//   "tripcomevilagency"となり、trusted_ota "trip.com"（正規化後"tripcom"）の前方一致で
//   trusted_otaに誤判定された（trusted OTA名を前置しただけの別名によるなりすまし）。
// 完全一致のみにすることで、この2方向のなりすまし経路をどちらも遮断する。
function normalizedEquals(a: string, b: string): boolean {
	if (a === "" || b === "") return false;
	return a === b;
}

export function classifySeller(
	input: {
		seller: string;
		isAirlineDirectHint?: boolean;
		legAirlines: string[];
	},
	trustedOtas: string[],
): SellerOffer["trust"] {
	// 1. ソース側のヒント（例: SerpAPIのairlineフラグ）を無条件で信用する。
	if (input.isAirlineDirectHint === true) return "airline";

	// 2. 販売元名を正規化し、運航会社名（leg）のいずれかと完全一致すればairline。
	//    normalizeSellerが「で予約/にて予約」接尾辞を剥がすため、「Thai AirAsia Xで予約」は
	//    正規化後「Thai AirAsia X」と完全一致になる（=表記揺れの吸収はnormalizeSeller側の
	//    責務であり、ここでの一致判定は完全一致のみ）。部分一致・前方一致は採用しない
	//    （詳細はnormalizedEqualsのコメント参照）。
	const seller = normalizeSeller(input.seller);
	const legAirlines = input.legAirlines.map(normalizeSeller);
	if (legAirlines.some((leg) => normalizedEquals(seller, leg))) {
		return "airline";
	}

	// 3. 信頼済みOTA allowlistのいずれかと完全一致すればtrusted_ota。
	//    前方一致・部分一致は採用しない（詳細はnormalizedEqualsのコメント参照）。
	//    CJKの装飾（例:「Trip.com（トリップ）」→"tripcom"）は正規化で消えるため完全一致の
	//    まま信頼される。一方、ラテン文字の接尾辞（例: "Trip.com (Japan)"→"tripcomjapan"）は
	//    完全一致にならずreference側に転ぶ。これは意図した安全側の挙動である。
	//    ラテン表記ゆれはtrusted_otas設定に明示追加して対応する。
	const otas = trustedOtas.map(normalizeSeller);
	if (otas.some((ota) => normalizedEquals(seller, ota))) {
		return "trusted_ota";
	}

	// 4. それ以外（Agoda・無名OTA等）はreference。
	return "reference";
}

// ヒント(isAirlineDirect)はソース(SerpAPIのairlineフラグ等)由来の一次情報にのみ使うこと —
// 再適用でtrustが粘着(ratchet)するため、applyTrustはソースから取得した直後のofferにのみ
// 適用する。理由: classifySellerのrule 1はisAirlineDirectHintが真なら無条件でairlineを
// 返す。一度trust==="airline"（=isAirlineDirect===true）になったofferを再度applyTrustに
// 通すと、そのtrueな値がそのままヒントとして入力されrule 1で即決してしまい、
// seller/legAirlinesの内容が変わってもairlineから剥がれなくなる。
export function applyTrust(
	offer: VerifiedOffer,
	trustedOtas: string[],
): VerifiedOffer {
	const legAirlines = [offer.airline].filter((a): a is string => Boolean(a));
	const sellers: SellerOffer[] = offer.sellers.map((seller) => {
		const trust = classifySeller(
			{
				seller: seller.seller,
				isAirlineDirectHint: seller.isAirlineDirect,
				legAirlines,
			},
			trustedOtas,
		);
		return { ...seller, trust, isAirlineDirect: trust === "airline" };
	});
	return { ...offer, sellers };
}

export function bestTrustedSeller(
	offer: VerifiedOffer,
): SellerOffer | undefined {
	const trusted = offer.sellers.filter((s) => s.trust !== "reference");
	return trusted.reduce<SellerOffer | undefined>(
		(best, s) => (!best || s.priceJpy < best.priceJpy ? s : best),
		undefined,
	);
}

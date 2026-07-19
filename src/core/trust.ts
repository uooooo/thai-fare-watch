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

// 正規化済み文字列どうしの「包含」判定。どちらかが空文字なら常にfalseとする
// GUARD: ガードなしだと"".includes("")===trueとなり、CJKのみの販売元名と
// CJKのみの運航会社名が（内容と無関係に）無条件でairline一致してしまう。
function normalizedIncludes(haystack: string, needle: string): boolean {
	if (haystack === "" || needle === "") return false;
	return haystack.includes(needle);
}

function normalizedIncludesEitherWay(a: string, b: string): boolean {
	return normalizedIncludes(a, b) || normalizedIncludes(b, a);
}

// 正規化済みの販売元名がOTA allowlistエントリと「完全一致」または「前方一致」するかの判定。
// 信頼フィルタは偽陽性（untrustedなOTAをtrusted扱いしてしまう）が致命的・偽陰性
// （trustedなOTAを見逃してreference扱いになる）は安全側、という非対称性があるため、
// 任意位置の部分一致(contains)ではなく前方一致に限定する。
// 例: "Trip.com (Japan)" → "tripcomjapan" は "tripcom" の前方一致でOK（trusted_ota）。
//     "Mytrip.com" → "mytripcom" は "tripcom" を含むが前方一致ではないためNG（reference）。
// GUARD: どちらかが空文字なら常にfalse。ガード無しだと"".startsWith("")===trueとなり、
// allowlistエントリがCJKのみ（正規化後に空文字）の場合に無条件でマッチしてしまう。
function normalizedMatchesOta(seller: string, ota: string): boolean {
	if (seller === "" || ota === "") return false;
	return seller === ota || seller.startsWith(ota);
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

	// 2. 販売元名を正規化し、運航会社名（leg）のいずれかと片方向包含すればairline。
	//    （「Thai AirAsia Xで予約」⊇「Thai AirAsia X」のような表記揺れを吸収する）
	const seller = normalizeSeller(input.seller);
	const legAirlines = input.legAirlines.map(normalizeSeller);
	if (legAirlines.some((leg) => normalizedIncludesEitherWay(seller, leg))) {
		return "airline";
	}

	// 3. 信頼済みOTA allowlistのいずれかと完全一致または前方一致すればtrusted_ota。
	//    （contains全般は採用しない。詳細はnormalizedMatchesOtaのコメント参照）
	const otas = trustedOtas.map(normalizeSeller);
	if (otas.some((ota) => normalizedMatchesOta(seller, ota))) {
		return "trusted_ota";
	}

	// 4. それ以外（Agoda・無名OTA等）はreference。
	return "reference";
}

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

import type { Config } from "../config";
import { QuotaExceededError } from "../sources/serpapi";
import type { FareSource, RunnerEnv } from "../sources/types";
import type {
	FareObservation,
	Itinerary,
	Leg,
	SellerOffer,
	Verification,
	VerifiedOffer,
} from "../types";
import { isGround } from "../types";
import { applyTrust, bestTrustedSeller } from "./trust";

export type VerifyDeps = { sources: FareSource[]; env: RunnerEnv; cfg: Config };

const PRICE_BAND_RATIO = 0.2;

// 同便名優先。無ければ±20%以内の最安をマッチとする。
function matchOffer(
	offers: VerifiedOffer[],
	leg: FareObservation,
): VerifiedOffer | undefined {
	if (leg.flightNumber) {
		return offers.find((o) => o.flightNumber === leg.flightNumber);
	}
	const band = leg.priceJpy * PRICE_BAND_RATIO;
	const withinBand = offers.filter(
		(o) => Math.abs(o.priceJpy - leg.priceJpy) <= band,
	);
	return withinBand.reduce<VerifiedOffer | undefined>(
		(best, o) => (!best || o.priceJpy < best.priceJpy ? o : best),
		undefined,
	);
}

// 全flightレグをfliで価格確認。1レグでもマッチしなければundefined(=中断)を返す。
// groundレグはそのまま素通しする。
async function priceConfirmStage(
	legs: Leg[],
	fli: FareSource,
): Promise<Leg[] | undefined> {
	if (!fli.verify) return legs;
	const out: Leg[] = [];
	for (const leg of legs) {
		if (isGround(leg)) {
			out.push(leg);
			continue;
		}
		const offers = await fli.verify(
			{ origin: leg.origin, destination: leg.destination, market: leg.market },
			leg.departDate,
		);
		const matched = matchOffer(offers, leg);
		if (!matched) return undefined;
		out.push({ ...leg, priceJpy: matched.priceJpy });
	}
	return out;
}

type SellerStageResult = {
	verifiedCount: number;
	flightLegCount: number;
	seller?: SellerOffer;
	quotaExceeded: boolean;
};

// 販売元ソースで各flightレグを検証。QuotaExceededErrorは即座に打ち切る(以降のレグは試行しない)。
// 最初のflightレグで見つかった最安trustedを`seller`として返す。
async function sellerStage(
	legs: Leg[],
	sellerSource: FareSource,
	trustedOtas: string[],
): Promise<SellerStageResult> {
	let verifiedCount = 0;
	let flightLegCount = 0;
	let seller: SellerOffer | undefined;
	let quotaExceeded = false;
	let isFirstFlightLeg = true;

	for (const leg of legs) {
		if (isGround(leg) || !sellerSource.verify) continue;
		flightLegCount++;
		const isFirst = isFirstFlightLeg;
		isFirstFlightLeg = false;
		if (quotaExceeded) continue;

		try {
			const offers = await sellerSource.verify(
				{
					origin: leg.origin,
					destination: leg.destination,
					market: leg.market,
				},
				leg.departDate,
			);
			const matched = matchOffer(offers, leg);
			if (!matched) continue;
			const best = bestTrustedSeller(applyTrust(matched, trustedOtas));
			if (best) {
				verifiedCount++;
				if (isFirst) seller = best;
			}
		} catch (err) {
			if (err instanceof QuotaExceededError) {
				quotaExceeded = true;
				continue;
			}
			throw err;
		}
	}
	return { verifiedCount, flightLegCount, seller, quotaExceeded };
}

// totalJpy/fxFeeJpyを(更新済みの)legsから再計算する。海外市場のflightレグにのみ
// 外貨手数料(cfg.fx_fee_rate)を上乗せする。groundレグはそのままpriceJpyを加算する。
function recomputeTotals(it: Itinerary, cfg: Config): Itinerary {
	let totalJpy = 0;
	let fxFeeJpy = 0;
	for (const l of it.legs) {
		if (isGround(l)) {
			totalJpy += l.priceJpy;
			continue;
		}
		const effective =
			l.market === "jp"
				? l.priceJpy
				: Math.round(l.priceJpy * (1 + cfg.fx_fee_rate));
		totalJpy += effective;
		fxFeeJpy += effective - l.priceJpy;
	}
	return { ...it, totalJpy, fxFeeJpy };
}

// 検証パイプライン本体。
// 1. fli(利用可能なら)で全flightレグの価格確認。1レグでも不一致なら元のitineraryを
//    無変更で返す(seller無し)。
// 2. 販売元ソース(gf-browser優先、無ければserpapi)で各flightレグを検証し、
//    applyTrust→bestTrustedSellerでtrusted seller有無を判定。
// 3. 全レグtrusted→"verified" / 一部→"partial" / それ以外はstage1の結果を保持
//    ("price_confirmed" if stage1実行、そうでなければ元のverification)。
// 4. QuotaExceededErrorはseller検証を打ち切り、price_confirmed(またはそのまま)へ縮退する。
// 入力itineraryは変更しない(常に新規オブジェクトを返す。ただしstage1で不一致の場合は
// 元の参照をそのまま返す=内容は無変更)。
export async function verifyItinerary(
	it: Itinerary,
	deps: VerifyDeps,
): Promise<{ itinerary: Itinerary; seller?: SellerOffer }> {
	const { sources, env, cfg } = deps;

	const fli = sources.find(
		(s) => s.name === "fli" && s.verify && s.available(env),
	);
	let legs = it.legs;
	let stage1Ran = false;
	if (fli) {
		const updated = await priceConfirmStage(it.legs, fli);
		if (!updated) return { itinerary: it };
		legs = updated;
		stage1Ran = true;
	}

	const sellerSource =
		sources.find(
			(s) => s.name === "gf-browser" && s.verify && s.available(env),
		) ??
		sources.find((s) => s.name === "serpapi" && s.verify && s.available(env));

	let verification: Verification = stage1Ran
		? "price_confirmed"
		: it.verification;
	let seller: SellerOffer | undefined;

	if (sellerSource) {
		const result = await sellerStage(legs, sellerSource, cfg.trusted_otas);
		if (!result.quotaExceeded) {
			if (
				result.flightLegCount > 0 &&
				result.verifiedCount === result.flightLegCount
			) {
				verification = "verified";
				seller = result.seller;
			} else if (result.verifiedCount > 0) {
				verification = "partial";
				seller = result.seller;
			}
		}
	}

	return {
		itinerary: recomputeTotals({ ...it, legs, verification }, cfg),
		seller,
	};
}

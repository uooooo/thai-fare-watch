import type { Config } from "../config";
import type { FareObservation, Itinerary, Tier } from "../types";
import { isGround } from "../types";

function flightLegsOf(it: Itinerary): FareObservation[] {
	return it.legs.filter((l): l is FareObservation => !isGround(l));
}

// verified: ≤flash_max→"flash"、≤notify_max→"deal"。
// unverified/price_confirmed/partial: ≤notify_max→"candidate"。
// いずれの範囲にも収まらない場合はundefined（通知なし・deals.jsonには残る）。
export function assignTier(it: Itinerary, cfg: Config): Tier | undefined {
	const { notify_max, flash_max } = cfg.thresholds;
	if (it.verification === "verified") {
		if (it.totalJpy <= flash_max) return "flash";
		return it.totalJpy <= notify_max ? "deal" : undefined;
	}
	return it.totalJpy <= notify_max ? "candidate" : undefined;
}

// 再通知抑制の識別キー。flightレグのみを対象にし、groundレグは無視する。
export function dealKey(it: Itinerary): string {
	const flightLegs = flightLegsOf(it);
	const segments = flightLegs
		.map((l) => `${l.origin}-${l.destination}`)
		.join(",");
	const flightNums = flightLegs.map((l) => l.flightNumber ?? "").join("+");
	const departDate = flightLegs[0]?.departDate ?? "";
	const sellerClass = it.verification === "verified" ? "trusted" : "none";
	return `${segments}|${departDate}|${flightNums}|${sellerClass}`;
}

// (a) 前回通知なし→true
// (b) 値下がりがmax(500, last.priceJpy*0.03)以上→true
// (c) 前回tierがcandidateで今回flash/dealに昇格→true
// それ以外はfalse（key/nowは呼び出し側の識別子・時刻であり、判定ロジックでは使わない）
export function shouldNotify(
	it: Itinerary,
	_key: string,
	last: { priceJpy: number; at: string; tier: string } | undefined,
	_now: Date,
): boolean {
	if (last === undefined) return true;
	if (last.tier === "candidate" && (it.tier === "flash" || it.tier === "deal"))
		return true;
	const drop = last.priceJpy - it.totalJpy;
	return drop >= Math.max(500, last.priceJpy * 0.03);
}

// 最初のflightレグの出発日がtodayJstStrより前のものを除外する（当日は残す）。
// flightレグを持たないitineraryも除外する。
export function expireDeals(
	deals: Itinerary[],
	todayJstStr: string,
): Itinerary[] {
	return deals.filter((it) => {
		const first = flightLegsOf(it)[0];
		if (!first) return false;
		return !(first.departDate < todayJstStr);
	});
}

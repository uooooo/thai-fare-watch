import type { Config } from "../config";
import type { FareObservation, GroundLeg, Itinerary, Leg } from "../types";
import { isGround } from "../types";
import { addDays, hoursBetween } from "../util/dates";
import { stableId } from "../util/hash";

// 空港コード→都市コードの正規化表。未知のコードはそれ自身が都市コード扱い。
const CITY_OF: Record<string, string> = {
	NRT: "TYO",
	HND: "TYO",
	KIX: "OSA",
	ITM: "OSA",
	ICN: "SEL",
	GMP: "SEL",
	DMK: "BKK",
};

function cityOf(code: string): string {
	return CITY_OF[code] ?? code;
}

// 同一都市の空港間移動が必要な接続に許す最短時間（時刻既知時）
const AIRPORT_CHANGE_MIN_HOURS = 6;
// この時刻より前に国際線が出る場合、地上ポジショニングは前日移動を推奨
const EARLY_DEPARTURE_HOUR = 12;

type PairResult = { risks: string[] } | null;

// 別切り2レグ（または国内アクセス+国際レグ）の接続可否を判定する。
// 日付: 同日 or (allow_next_day時) 翌日のみ。
// 時刻既知: min_connect_hours〜max_connect_hours を強制。
// 時刻不明: 同日は「時刻要確認」、翌日は「翌日乗継(宿泊の可能性)」リスクを付与。
// 空港不一致(生の空港コード比較): 時刻既知でAIRPORT_CHANGE_MIN_HOURS未満は不成立、
// それ以外は「空港移動あり」リスクを付与。
function pairLegs(
	a: FareObservation,
	b: FareObservation,
	rules: Config["combine"],
): PairResult {
	const sameDay = b.departDate === a.departDate;
	const nextDay = b.departDate === addDays(a.departDate, 1);
	if (!sameDay && !(rules.allow_next_day && nextDay)) return null;

	const risks: string[] = [];
	const airportMismatch = a.destination !== b.origin;
	if (a.arriveAt && b.departAt) {
		const connect = hoursBetween(a.arriveAt, b.departAt);
		if (connect < rules.min_connect_hours || connect > rules.max_connect_hours)
			return null;
		if (airportMismatch) {
			if (connect < AIRPORT_CHANGE_MIN_HOURS) return null;
			risks.push("空港移動あり");
		}
	} else {
		risks.push(sameDay ? "時刻要確認" : "翌日乗継(宿泊の可能性)");
		if (airportMismatch) risks.push("空港移動あり");
	}
	return { risks };
}

function legId(l: Leg): string {
	return isGround(l)
		? stableId("ground", l.from, l.to, l.mode, l.priceJpy)
		: l.id;
}

function departHour(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const m = /T(\d{2}):/.exec(iso);
	return m?.[1] === undefined ? undefined : Number(m[1]);
}

function buildItinerary(
	legs: Leg[],
	risks: string[],
	cfg: Config,
	positioned: boolean,
): Itinerary {
	let totalJpy = 0;
	let fxFeeJpy = 0;
	for (const l of legs) {
		if (isGround(l)) {
			totalJpy += l.priceJpy;
			continue;
		}
		// 海外市場レグには外貨決済手数料を上乗せした実効JPYで比較する
		const effective =
			l.market === "jp"
				? l.priceJpy
				: Math.round(l.priceJpy * (1 + cfg.fx_fee_rate));
		totalJpy += effective;
		fxFeeJpy += effective - l.priceJpy;
	}
	const flightLegs = legs.filter((l): l is FareObservation => !isGround(l));
	const kind: Itinerary["kind"] = positioned
		? "positioned"
		: flightLegs.length >= 2
			? "self_transfer"
			: (flightLegs[0]?.transfers ?? 0) > 0
				? "through"
				: "direct";
	return {
		id: stableId(...legs.map(legId)),
		kind,
		legs,
		totalJpy,
		fxFeeJpy,
		risks: [...new Set(risks)],
		verification: "unverified",
	};
}

// 総所要時間の上限チェック。最初/最後のflightレグの時刻が両方既知の場合のみ適用し、
// 先頭のgroundレグの所要時間も加味する。時刻不明の経路は除外しない。
function withinTotalHours(it: Itinerary, rules: Config["combine"]): boolean {
	const flightLegs = it.legs.filter((l): l is FareObservation => !isGround(l));
	const first = flightLegs[0];
	const last = flightLegs[flightLegs.length - 1];
	if (!first?.departAt || !last?.arriveAt) return true;
	const head = it.legs[0];
	const groundHours = head && isGround(head) ? head.hours : 0;
	return (
		hoursBetween(first.departAt, last.arriveAt) + groundHours <=
		rules.max_total_hours
	);
}

// 観測値集合から経路(Itinerary)を合成する。
// ① 直行/単一予約 ② 別切り2レグ(ハブ経由) ③ 国内ポジショニング(ground/国内線)+①or②
export function combine(
	observations: FareObservation[],
	cfg: Config,
): Itinerary[] {
	const rules = cfg.combine;
	const byRoute = new Map<string, FareObservation[]>();
	for (const o of observations) {
		const key = `${cityOf(o.origin)}|${cityOf(o.destination)}`;
		const list = byRoute.get(key);
		if (list) list.push(o);
		else byRoute.set(key, [o]);
	}
	const get = (o: string, d: string) => byRoute.get(`${o}|${d}`) ?? [];

	const out: Itinerary[] = [];
	const intlOrigins = [...cfg.origins, ...cfg.positioning];
	for (const origin of intlOrigins) {
		// この起点からの国際部分（1レグ直行 or 2レグ別切り）を列挙
		const parts: { legs: FareObservation[]; risks: string[] }[] = [];
		for (const dest of cfg.destinations) {
			for (const obs of get(origin, dest))
				parts.push({ legs: [obs], risks: [] });
			for (const hub of cfg.hubs) {
				for (const l1 of get(origin, hub)) {
					for (const l2 of get(hub, dest)) {
						const p = pairLegs(l1, l2, rules);
						if (p)
							parts.push({
								legs: [l1, l2],
								risks: ["自己乗継(別切り)", ...p.risks],
							});
					}
				}
			}
		}
		for (const part of parts) {
			if (cfg.origins.includes(origin)) {
				out.push(buildItinerary(part.legs, part.risks, cfg, false));
				continue;
			}
			// ポジショニング起点: 地上アクセス（表にあれば）
			const g = cfg.ground.find((entry) => entry.to === origin);
			if (g) {
				const groundLeg: GroundLeg = {
					kind: "ground",
					mode: g.mode,
					from: "TYO",
					to: origin,
					priceJpy: g.priceJpy,
					hours: g.hours,
				};
				const risks = [...part.risks];
				const hour = departHour(part.legs[0]?.departAt);
				if (hour !== undefined && hour < EARLY_DEPARTURE_HOUR)
					risks.push("前日移動推奨");
				out.push(buildItinerary([groundLeg, ...part.legs], risks, cfg, true));
			}
			// 国内線アクセス（TYO→ポジショニング空港の観測）。別切り扱い。
			const firstIntl = part.legs[0];
			if (!firstIntl) continue;
			for (const dom of get("TYO", origin)) {
				const p = pairLegs(dom, firstIntl, rules);
				if (p)
					out.push(
						buildItinerary(
							[dom, ...part.legs],
							[...part.risks, "自己乗継(別切り)", ...p.risks],
							cfg,
							true,
						),
					);
			}
		}
	}

	const seen = new Set<string>();
	const deduped: Itinerary[] = [];
	for (const it of out) {
		if (seen.has(it.id)) continue;
		seen.add(it.id);
		deduped.push(it);
	}
	return deduped
		.filter((it) => withinTotalHours(it, rules))
		.sort((a, b) => a.totalJpy - b.totalJpy)
		.slice(0, 20);
}

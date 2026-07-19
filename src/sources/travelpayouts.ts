import type { Config } from "../config";
import type { DateRange, FareObservation, OdPair } from "../types";
import { monthsTouched } from "../util/dates";
import { stableId } from "../util/hash";
import { fetchJson, safeErrorMessage } from "../util/http";
import type { FareSource, RunnerEnv } from "./types";

const ENDPOINT = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";
const EXPIRES_AFTER_MS = 48 * 60 * 60 * 1000;

type TpDataItem = {
	origin: string;
	destination: string;
	origin_airport?: string;
	destination_airport?: string;
	price: number;
	airline?: string;
	flight_number?: string;
	departure_at: string;
	transfers?: number;
	duration_to?: number;
	link?: string;
};

type TpResponse = {
	success?: boolean;
	currency?: string;
	data?: TpDataItem[];
};

type TravelpayoutsDeps = {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: Date;
};

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(pair: OdPair, month: string, token: string): string {
	const params = new URLSearchParams({
		origin: pair.origin,
		destination: pair.destination,
		departure_at: month,
		one_way: "true",
		direct: "false",
		currency: "jpy",
		market: pair.market,
		limit: "1000",
		sorting: "price",
		token,
	});
	return `${ENDPOINT}?${params.toString()}`;
}

function mapItem(
	item: TpDataItem,
	pair: OdPair,
	range: DateRange,
	now: Date,
): FareObservation | undefined {
	const departDate = item.departure_at.slice(0, 10);
	if (departDate < range.from || departDate > range.to) return undefined;

	const origin = item.origin_airport ?? item.origin;
	const destination = item.destination_airport ?? item.destination;
	const flightNumber = item.flight_number;
	const priceJpy = item.price;
	const foundAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + EXPIRES_AFTER_MS).toISOString();

	return {
		id: stableId("tp", origin, destination, departDate, flightNumber, priceJpy),
		source: "travelpayouts",
		origin,
		destination,
		departDate,
		departAt: item.departure_at,
		airline: item.airline,
		flightNumber,
		transfers: item.transfers ?? 0,
		priceJpy,
		market: pair.market,
		foundAt,
		expiresAt,
	};
}

export class TravelpayoutsSource implements FareSource {
	name = "travelpayouts";

	constructor(
		private readonly cfg: Config,
		private readonly deps: TravelpayoutsDeps = {},
	) {}

	available(_env: RunnerEnv): boolean {
		return Boolean(this.cfg.secrets.travelpayoutsToken);
	}

	async sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]> {
		const token = this.cfg.secrets.travelpayoutsToken ?? "";
		const fetchImpl = this.deps.fetchImpl ?? fetch;
		const sleep = this.deps.sleep ?? defaultSleep;
		const now = this.deps.now ?? new Date();
		const months = monthsTouched(range);

		const out: FareObservation[] = [];
		let attempted = 0;
		let anySucceeded = false;

		for (const pair of pairs) {
			for (const month of months) {
				attempted++;
				const url = buildUrl(pair, month, token);
				try {
					const res = await fetchJson<TpResponse>(url, { fetchImpl });
					anySucceeded = true;
					if (res.success === true) {
						for (const item of res.data ?? []) {
							const obs = mapItem(item, pair, range, now);
							if (obs) out.push(obs);
						}
					}
				} catch (err) {
					// 生Errorオブジェクトを渡さない —ネットワークエラーのenumerableな.path
					// (秘密含む生URL)をconsoleが展開して漏らすため、必ず文字列化してから渡す。
					console.warn(
						`travelpayouts: sweep failed for ${pair.origin}->${pair.destination} (${month}): ${safeErrorMessage(err)}`,
					);
				}
				await sleep(150);
			}
		}

		if (attempted > 0 && !anySucceeded) {
			throw new Error("travelpayouts: all sweep requests failed");
		}

		return out;
	}
}

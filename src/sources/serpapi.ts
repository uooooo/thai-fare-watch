import type { Config } from "../config";
import type { Store } from "../state/store";
import type {
	FareObservation,
	OdPair,
	SellerOffer,
	VerifiedOffer,
} from "../types";
import { todayJst } from "../util/dates";
import { stableId } from "../util/hash";
import { fetchJson } from "../util/http";
import type { FareSource, RunnerEnv } from "./types";

const SEARCH_ENDPOINT = "https://serpapi.com/search.json";

// Google Flightsが都市コード検索に対応していない/複数空港を束ねたい主要都市のみ、
// 実空港コードへ展開する。対応外の都市コードはそのまま渡す（Googleが解釈できる想定）。
const CITY_AIRPORTS: Record<string, string> = {
	TYO: "NRT,HND",
	BKK: "BKK,DMK",
	OSA: "KIX,ITM",
	SEL: "ICN,GMP",
};

export class QuotaExceededError extends Error {
	constructor(message = "serpapi: monthly quota exceeded") {
		super(message);
		this.name = "QuotaExceededError";
	}
}

// ---- SerpAPI (google_flights engine) レスポンス形状（ダミー実形状） -----------------
type SerpAirportPoint = { id: string; time: string }; // time: "YYYY-MM-DD HH:MM"（オフセットなし現地時刻）
type SerpFlightLeg = {
	departure_airport: SerpAirportPoint;
	arrival_airport: SerpAirportPoint;
	airline: string;
	flight_number: string;
};
type SerpItinerary = {
	flights: SerpFlightLeg[];
	price: number;
	total_duration?: number;
	booking_token?: string;
};
type SerpSearchResponse = {
	best_flights?: SerpItinerary[];
	other_flights?: SerpItinerary[];
};
type SerpBookingTogether = {
	book_with: string;
	airline: boolean;
	price: number;
	booking_request?: { url?: string };
};
type SerpBookingOption = { together: SerpBookingTogether };
type SerpBookingResponse = { booking_options?: SerpBookingOption[] };

type ParsedItinerary = { obs: FareObservation; price: number; token?: string };

function airportsFor(cityOrAirport: string): string {
	return CITY_AIRPORTS[cityOrAirport] ?? cityOrAirport;
}

// "YYYY-MM-DD HH:MM" → "YYYY-MM-DDTHH:MM"（オフセットなし。現地時刻のまま保持する）。
function toLocalIso(raw: string): string {
	return raw.replace(" ", "T");
}

function buildSearchUrl(cfg: Config, od: OdPair, date: string): string {
	const params = new URLSearchParams({
		engine: "google_flights",
		departure_id: airportsFor(od.origin),
		arrival_id: airportsFor(od.destination),
		outbound_date: date,
		type: "2", // 片道
		currency: "JPY",
		gl: "jp",
		hl: "ja",
		api_key: cfg.secrets.serpapiKey ?? "",
	});
	return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

// 月内の残日数（今日を含む、JST基準）。
function daysLeftInMonth(now: Date): number {
	const today = todayJst(now);
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7)); // 1-indexed
	const day = Number(today.slice(8, 10));
	const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return lastDayOfMonth - day + 1;
}

function parseItinerary(
	raw: SerpItinerary,
	date: string,
	foundAt: string,
): ParsedItinerary | undefined {
	const flights = raw.flights;
	if (!Array.isArray(flights) || flights.length === 0) return undefined;
	const first = flights[0];
	const last = flights[flights.length - 1];
	if (!first || !last) return undefined;

	const origin = first.departure_airport.id;
	const destination = last.arrival_airport.id;
	const flightNumber = flights.map((f) => f.flight_number).join("+");
	const priceJpy = raw.price;

	const obs: FareObservation = {
		id: stableId("serp", origin, destination, date, flightNumber, priceJpy),
		source: "serpapi",
		origin,
		destination,
		departDate: date,
		departAt: toLocalIso(first.departure_airport.time),
		arriveAt: toLocalIso(last.arrival_airport.time),
		airline: first.airline,
		flightNumber,
		transfers: flights.length - 1,
		priceJpy,
		market: "jp",
		foundAt,
	};
	return { obs, price: priceJpy, token: raw.booking_token };
}

function mapBookingOptions(res: SerpBookingResponse): SellerOffer[] {
	return (res.booking_options ?? []).map(({ together }) => ({
		seller: together.book_with,
		isAirlineDirect: together.airline === true,
		trust: together.airline === true ? "airline" : "reference",
		priceJpy: together.price,
		bookingUrl: together.booking_request?.url,
	}));
}

// 月間クォータの自己管理。remainingMonth/tryConsumeは常にStore.readQuota()（当月に
// 自動リセットされる）を基準にする。dailyBudgetは「今日消費してよい目安」であり
// 強制はしない（実運用の日次配分はパイプライン側の責務）。
export class QuotaManager {
	constructor(
		private readonly store: Store,
		private readonly cfg: Config,
		private readonly now?: Date,
	) {}

	remainingMonth(): number {
		const { used } = this.store.readQuota();
		return Math.max(0, this.cfg.serpapi.monthly_quota - used);
	}

	dailyBudget(): number {
		const remaining = this.remainingMonth();
		const days = daysLeftInMonth(this.now ?? new Date());
		return Math.min(
			Math.ceil(remaining / days),
			this.cfg.serpapi.daily_budget_cap,
		);
	}

	tryConsume(n: number): boolean {
		const { month, used } = this.store.readQuota();
		if (used + n > this.cfg.serpapi.monthly_quota) return false;
		this.store.writeQuota({ month, used: used + n });
		return true;
	}
}

export class SerpApiSource implements FareSource {
	name = "serpapi";
	private readonly cfg: Config;
	private readonly quota: QuotaManager;
	private readonly fetchImpl: typeof fetch;
	private readonly now?: Date;

	constructor(
		cfg: Config,
		deps: { store: Store; fetchImpl?: typeof fetch; now?: Date },
	) {
		this.cfg = cfg;
		this.quota = new QuotaManager(deps.store, cfg, deps.now);
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.now = deps.now;
	}

	available(_env: RunnerEnv): boolean {
		return (
			Boolean(this.cfg.secrets.serpapiKey) &&
			this.quota.remainingMonth() > 0 &&
			this.quota.dailyBudget() > 0
		);
	}

	// 検索1回 + 最安便（booking_token有り）のbooking options 1回 = 最大2消費。
	async verify(od: OdPair, date: string): Promise<VerifiedOffer[]> {
		if (!this.quota.tryConsume(1)) throw new QuotaExceededError();

		const searchUrl = buildSearchUrl(this.cfg, od, date);
		const res = await fetchJson<SerpSearchResponse>(searchUrl, {
			fetchImpl: this.fetchImpl,
		});
		const foundAt = (this.now ?? new Date()).toISOString();

		const raws = [...(res.best_flights ?? []), ...(res.other_flights ?? [])];
		const parsedList = raws
			.map((raw) => parseItinerary(raw, date, foundAt))
			.filter((p): p is ParsedItinerary => p !== undefined);

		let cheapestIndex = -1;
		let cheapestPrice = Number.POSITIVE_INFINITY;
		parsedList.forEach((p, i) => {
			if (p.price < cheapestPrice) {
				cheapestPrice = p.price;
				cheapestIndex = i;
			}
		});

		// クォータ節約: booking optionsは最安便（かつbooking_tokenを持つ場合）のみ取得。
		let cheapestSellers: SellerOffer[] = [];
		const cheapestToken =
			cheapestIndex >= 0 ? parsedList[cheapestIndex]?.token : undefined;
		if (cheapestToken) {
			if (!this.quota.tryConsume(1)) throw new QuotaExceededError();
			const bookingUrl = `${searchUrl}&booking_token=${encodeURIComponent(cheapestToken)}`;
			const bookingRes = await fetchJson<SerpBookingResponse>(bookingUrl, {
				fetchImpl: this.fetchImpl,
			});
			cheapestSellers = mapBookingOptions(bookingRes);
		}

		return parsedList.map((p, i) => ({
			...p.obs,
			sellers: i === cheapestIndex ? cheapestSellers : [],
		}));
	}
}

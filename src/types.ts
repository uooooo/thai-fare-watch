export type FareObservation = {
	id: string;
	source: "gf-browser" | "fli" | "travelpayouts" | "serpapi" | (string & {});
	origin: string; // IATA都市/空港コード（大文字）
	destination: string;
	departDate: string; // YYYY-MM-DD（現地）
	departAt?: string; // ISO8601
	arriveAt?: string;
	airline?: string; // 2レターor名称
	flightNumber?: string;
	transfers: number; // 単一予約内の乗継数
	priceJpy: number; // 整数JPY（手数料含まず）
	market: string; // "jp" | "kr" | ...
	foundAt: string; // ISO8601
	expiresAt?: string;
};

export type SellerOffer = {
	seller: string;
	isAirlineDirect: boolean;
	trust: "airline" | "trusted_ota" | "reference";
	priceJpy: number;
	bookingUrl?: string;
};

export type VerifiedOffer = FareObservation & { sellers: SellerOffer[] };

export type GroundLeg = {
	kind: "ground";
	mode: "train" | "bus";
	from: string; // "TYO"
	to: string; // 空港/都市コード
	priceJpy: number;
	hours: number;
};

export type Leg = FareObservation | GroundLeg;
export const isGround = (l: Leg): l is GroundLeg =>
	(l as GroundLeg).kind === "ground";

export type Verification =
	| "unverified"
	| "price_confirmed"
	| "partial"
	| "verified";
export type Tier = "flash" | "deal" | "candidate";

export type Itinerary = {
	id: string;
	kind: "direct" | "through" | "self_transfer" | "positioned";
	legs: Leg[];
	totalJpy: number;
	fxFeeJpy: number;
	risks: string[];
	verification: Verification;
	tier?: Tier;
};

export type SaleNews = {
	guid: string;
	feed: string;
	title: string;
	url: string;
	matchedKeywords: string[];
	publishedAt: string;
};

export type SourceHealth = {
	lastOkAt?: string;
	lastErrorAt?: string;
	lastError?: string;
	consecutiveFailures: number;
	// health embedを実際にキューへ積んだ時刻(ISO8601)。1日1回ガード(I4)はこれだけを見る —
	// lastErrorAtは失敗ごとに毎回更新されるため、それを基準にすると「OKでconsecutiveFailures
	// がリセットされた後の新しい6連続失敗」まで誤って抑制してしまう。
	lastAlertedAt?: string;
};

export type DateRange = { from: string; to: string }; // 両端含む YYYY-MM-DD
export type OdPair = { origin: string; destination: string; market: string };

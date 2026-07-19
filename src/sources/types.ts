import type {
	DateRange,
	FareObservation,
	OdPair,
	VerifiedOffer,
} from "../types";

export type RunnerEnv = { isCI: boolean; hasBrowser: boolean; now: Date };

export interface FareSource {
	name: string;
	available(env: RunnerEnv): boolean;
	sweep?(pairs: OdPair[], range: DateRange): Promise<FareObservation[]>;
	verify?(od: OdPair, date: string): Promise<VerifiedOffer[]>;
}

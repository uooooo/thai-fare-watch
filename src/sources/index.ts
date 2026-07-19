import type { Config } from "../config";
import type { Store } from "../state/store";
import { FliSource, makeCiBreaker } from "./fli";
import { SerpApiSource } from "./serpapi";
import { TravelpayoutsSource } from "./travelpayouts";
import type { FareSource, RunnerEnv } from "./types";

// ソースアダプタ登録点。available()判定は各呼び出し側(pipeline等)がenv基準で行うため、
// ここでは絞り込まず全ソースを返す。
export function buildSources(
	cfg: Config,
	store: Store,
	env: RunnerEnv,
): FareSource[] {
	return [
		// gf-browser(Playwright+Chrome, ローカル専用の主砲)はTask 15でここに追加する。
		new FliSource(cfg, { breaker: makeCiBreaker(store, cfg, env) }),
		new TravelpayoutsSource(cfg),
		new SerpApiSource(cfg, { store, now: env.now }),
	];
}

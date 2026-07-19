import type { Config } from "../config";
import type { Store } from "../state/store";
import { makeDryRunStore } from "../state/store";
import { FliSource, makeCiBreaker } from "./fli";
import { SerpApiSource } from "./serpapi";
import { TravelpayoutsSource } from "./travelpayouts";
import type { FareSource, RunnerEnv } from "./types";

// ソースアダプタ登録点。available()判定は各呼び出し側(pipeline等)がenv基準で行うため、
// ここでは絞り込まず全ソースを返す。
//
// opts.dryRun=true(C1): makeCiBreaker(fliのCB状態)とSerpApiSourceのQuotaManagerは、
// pipelineの`!dryRun`ガードを経由せず直接Storeへ書き込む(state.json/quota.json)。
// dryRun実行でもこれらが素通しで実ディスクに副作用を残すと、例えばfliが3回失敗する
// だけでdryRunからでも本物のCIサーキットブレーカが6時間openしてしまう。
// ドキュメント: dryRunで呼ぶ側は、pipeline.runWatchOnceにdryRun:trueを渡すだけでなく、
// 必ずここ(buildSources)にも{dryRun:true}を渡すこと — pipeline側のフラグだけでは
// この経路(ソース内部が直接触るStore)は保護されない。
export function buildSources(
	cfg: Config,
	store: Store,
	env: RunnerEnv,
	opts?: { dryRun?: boolean },
): FareSource[] {
	const effectiveStore = opts?.dryRun ? makeDryRunStore(store) : store;
	return [
		// gf-browser(Playwright+Chrome, ローカル専用の主砲)はTask 15でここに追加する。
		new FliSource(cfg, { breaker: makeCiBreaker(effectiveStore, cfg, env) }),
		new TravelpayoutsSource(cfg),
		new SerpApiSource(cfg, { store: effectiveStore, now: env.now }),
	];
}

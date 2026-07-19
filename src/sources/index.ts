import type { Config } from "../config";
import type { Store } from "../state/store";
import { makeDryRunStore } from "../state/store";
import { FliSource, makeCiBreaker } from "./fli";
import { GfBrowserSource } from "./gf-browser/index";
import { SerpApiSource } from "./serpapi";
import { SkyscannerBrowserSource } from "./skyscanner/index";
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
		// gf-browser(Playwright+Chrome, ローカル専用の主砲)。常に構築するが、CI/ブラウザ無し
		// 環境ではavailable(env)がfalseを返すため、呼び出し側(pipeline/cli)のavailable(env)
		// ガードにより実際には起動されない。
		new GfBrowserSource(cfg, { now: env.now }),
		new FliSource(cfg, { breaker: makeCiBreaker(effectiveStore, cfg, env) }),
		new TravelpayoutsSource(cfg),
		new SerpApiSource(cfg, { store: effectiveStore, now: env.now }),
		// skyscanner(Task 15b: Playwright, ローカル専用・best-effort)。gf-browserと同様
		// 常に構築するが、available(env)がCI/ブラウザ無し環境に加えcfg.skyscanner.enabled
		// およびcooldown中(直前のブロック検出後のstate.breakers.skyscanner)でもfalseを返す。
		// storeはdryRun時のみラップ済みのeffectiveStoreを渡す(fli/serpapiと同じくC1対策:
		// ソース内部が直接触るcooldownブレーカがdryRunガードを経由せず実ディスクに書き込む
		// 経路を持つため)。
		new SkyscannerBrowserSource(cfg, { store: effectiveStore, now: env.now }),
	];
}

import type { Config } from "../config";
import type { DiscordNotifier } from "../notify/discord";
import {
	buildDealEmbed,
	buildHealthEmbed,
	buildNewsEmbed,
} from "../notify/discord";
import type { RssSignal } from "../signals/rss";
import type { FareSource, RunnerEnv } from "../sources/types";
import type { Store } from "../state/store";
import type {
	FareObservation,
	Itinerary,
	OdPair,
	SellerOffer,
	SourceHealth,
} from "../types";
import { todayJst, windowToRange } from "../util/dates";
import { combine } from "./combiner";
import { assignTier, dealKey, expireDeals, shouldNotify } from "./dedupe";
import { verifyItinerary } from "./verify";
import { allJobs, dueJobs } from "./windows";

export type RunResult = {
	jobsRun: string[];
	observations: number;
	notified: number;
	errors: string[];
};

// origin都市→POS市場コード。未知のoriginは"jp"(既定)。
const MARKET_BY_ORIGIN: Record<string, string> = {
	SEL: "kr",
	TPE: "tw",
	KUL: "my",
	SGN: "vn",
	SIN: "sg",
	HKG: "hk",
	MNL: "ph",
};
function marketOf(origin: string): string {
	return MARKET_BY_ORIGIN[origin] ?? "jp";
}

// 掃引対象ペア: (origins∪positioning)→destinations、(origins∪positioning)→hubs、
// hubs→destinations、TYO→positioning(国内線アクセス)。重複ペアは除去する。
function buildPairs(cfg: Config): OdPair[] {
	const originsPlus = [...cfg.origins, ...cfg.positioning];
	const pairs: OdPair[] = [];
	const seen = new Set<string>();
	const push = (origin: string, destination: string) => {
		const key = `${origin}|${destination}`;
		if (seen.has(key)) return;
		seen.add(key);
		pairs.push({ origin, destination, market: marketOf(origin) });
	};
	for (const o of originsPlus) for (const d of cfg.destinations) push(o, d);
	for (const o of originsPlus) for (const h of cfg.hubs) push(o, h);
	for (const h of cfg.hubs) for (const d of cfg.destinations) push(h, d);
	for (const p of cfg.positioning) push("TYO", p);
	return pairs;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const VERIFY_BATCH_MAX = 5;
const HEALTH_FAILURE_THRESHOLD = 6;

// watch実行1回分。dueなジョブだけ処理し、常に(dryRunでも)全量計算した上で
// 実際のnotifier送信/state永続化だけをdryRunで抑制する。
export async function runWatchOnce(deps: {
	cfg: Config;
	store: Store;
	env: RunnerEnv;
	sources: FareSource[];
	rss: RssSignal;
	notifier?: DiscordNotifier;
	dryRun?: boolean;
}): Promise<RunResult> {
	const { cfg, store, env, sources, rss, notifier, dryRun = false } = deps;

	// 1. due算出
	const state = store.readState();
	const due = dueJobs(allJobs(cfg), state.lastRuns, env);

	const errors: string[] = [];
	const jobsRun: string[] = [];
	const runObservations: FareObservation[] = [];
	const newsEmbeds: object[] = [];
	const nextLastRuns: Record<string, string> = { ...state.lastRuns };
	const nextRssSeen: Record<string, string[]> = { ...state.rssSeen };
	let nextVerifyQueue: string[] = [...state.verifyQueue];

	// ソース稼働状況(health.json)。成功でconsecutiveFailuresリセット、失敗で+1し、
	// ちょうど6回目到達時(かつ本日まだ警告していなければ)health embedを追加する。
	const health = store.readHealth();
	const healthEmbeds: object[] = [];
	function recordHealthOk(name: string): void {
		health[name] = {
			...health[name],
			lastOkAt: env.now.toISOString(),
			consecutiveFailures: 0,
		};
	}
	function recordHealthFailure(name: string, message: string): void {
		const prev = health[name] ?? { consecutiveFailures: 0 };
		const consecutiveFailures = prev.consecutiveFailures + 1;
		const alreadyWarnedToday =
			prev.lastErrorAt !== undefined &&
			todayJst(new Date(prev.lastErrorAt)) === todayJst(env.now);
		const next: SourceHealth = {
			...prev,
			lastErrorAt: env.now.toISOString(),
			lastError: message,
			consecutiveFailures,
		};
		health[name] = next;
		if (
			consecutiveFailures === HEALTH_FAILURE_THRESHOLD &&
			!alreadyWarnedToday
		) {
			healthEmbeds.push(buildHealthEmbed(name, next));
		}
	}

	// 2. window job: 掃引可能ソース(sweepあり&&available)を全due窓に対して実行。
	// ソース単位の例外はerrorsに積んで継続する(窓ジョブ自体はlastRunを更新する)。
	const pairs = buildPairs(cfg);
	const sweepSources = sources.filter((s) => s.sweep);
	for (const job of due) {
		if (job.kind !== "window") continue;
		const range = windowToRange(job.window.from, job.window.to, env.now);
		for (const source of sweepSources) {
			if (!source.available(env)) continue;
			try {
				const obs = (await source.sweep?.(pairs, range)) ?? [];
				runObservations.push(...obs);
				recordHealthOk(source.name);
			} catch (err) {
				errors.push(`${source.name}: ${errMsg(err)}`);
				recordHealthFailure(source.name, errMsg(err));
			}
		}
		jobsRun.push(job.id);
		nextLastRuns[job.id] = env.now.toISOString();
	}

	// 3. rss job: pollしてマッチをニュースembed化。poll失敗時はそのフィードの
	// lastRun/rssSeenを更新しない(次回再試行させる)。
	for (const job of due) {
		if (job.kind !== "rss") continue;
		try {
			const seenBefore = state.rssSeen[job.feed.name] ?? [];
			const { news, seen } = await rss.poll(job.feed, seenBefore);
			for (const n of news) newsEmbeds.push(buildNewsEmbed(n));
			nextRssSeen[job.feed.name] = seen;
			jobsRun.push(job.id);
			nextLastRuns[job.id] = env.now.toISOString();
		} catch (err) {
			errors.push(`rss:${job.feed.name}: ${errMsg(err)}`);
		}
	}

	// 4. deep-sweep: "gf-browser"という名のソースが実際に登録・available出来ている
	// 場合のみ実行する。無ければ静かにスキップ(lastRunも更新しない=次回すぐdueのまま)。
	const deepSweepJob = due.find((j) => j.kind === "deep-sweep");
	if (deepSweepJob) {
		const gfBrowser = sources.find(
			(s) => s.name === "gf-browser" && s.available(env),
		);
		if (gfBrowser?.sweep) {
			const nearWindow =
				cfg.windows.find((w) => w.name === "near") ??
				cfg.windows[cfg.windows.length - 1];
			const range = nearWindow
				? windowToRange(0, nearWindow.to, env.now)
				: windowToRange(0, 30, env.now);
			try {
				const obs = await gfBrowser.sweep(pairs, range);
				runObservations.push(...obs);
				recordHealthOk(gfBrowser.name);
			} catch (err) {
				errors.push(`${gfBrowser.name}: ${errMsg(err)}`);
				recordHealthFailure(gfBrowser.name, errMsg(err));
			}
			jobsRun.push(deepSweepJob.id);
			nextLastRuns[deepSweepJob.id] = env.now.toISOString();
		}
	}

	// verify-queue: 検証能力(いずれかのソースがverify&&available)があるときのみ処理する。
	// state.verifyQueueのidをdeals.jsonから引いて再検証し、結果を後段のfinal合成に混ぜる。
	const queuedVerified = new Map<
		string,
		{ itinerary: Itinerary; seller?: SellerOffer }
	>();
	const verifyQueueJob = due.find((j) => j.kind === "verify-queue");
	if (verifyQueueJob) {
		const canVerify = sources.some((s) => s.verify && s.available(env));
		if (canVerify) {
			const queueIds = new Set(state.verifyQueue);
			if (queueIds.size > 0) {
				for (const it of store.readDeals()) {
					if (!queueIds.has(it.id)) continue;
					try {
						const result = await verifyItinerary(it, { sources, env, cfg });
						result.itinerary.tier = assignTier(result.itinerary, cfg);
						queuedVerified.set(it.id, result);
					} catch (err) {
						errors.push(`verify-queue:${it.id}: ${errMsg(err)}`);
					}
					queueIds.delete(it.id);
				}
			}
			nextVerifyQueue = [...queueIds];
			jobsRun.push(verifyQueueJob.id);
			nextLastRuns[verifyQueueJob.id] = env.now.toISOString();
		}
	}

	// 5. 合成+失効除去。今回の観測に加え直近48hの永続観測も合わせて評価する。
	const recentFares = store.readRecentFares(48, env.now);
	const combined = expireDeals(
		combine([...runObservations, ...recentFares], cfg),
		todayJst(env.now),
	);

	// 6. 検証: 通知しきい値(notify_max×watch_margin)以下・安い順に最大5件だけ検証する。
	const verifyThreshold =
		cfg.thresholds.notify_max * cfg.thresholds.watch_margin;
	const candidates = [...combined]
		.filter((it) => it.totalJpy <= verifyThreshold)
		.sort((a, b) => a.totalJpy - b.totalJpy)
		.slice(0, VERIFY_BATCH_MAX);

	const verifiedById = new Map<string, Itinerary>();
	const sellerById = new Map<string, SellerOffer>();
	for (const candidate of candidates) {
		try {
			const { itinerary: verified, seller } = await verifyItinerary(candidate, {
				sources,
				env,
				cfg,
			});
			verified.tier = assignTier(verified, cfg);
			verifiedById.set(candidate.id, verified);
			if (seller) sellerById.set(candidate.id, seller);
		} catch (err) {
			errors.push(`verify:${candidate.id}: ${errMsg(err)}`);
		}
	}

	const final = combined.map(
		(it) =>
			verifiedById.get(it.id) ?? queuedVerified.get(it.id)?.itinerary ?? it,
	);
	for (const [id, q] of queuedVerified) {
		if (q.seller) sellerById.set(id, q.seller);
	}

	// 7. 通知: tier(flash/deal/candidate)が付いたものだけ再通知抑制ルールにかける。
	const notifiedMap = store.readNotified();
	const dealEmbeds: object[] = [];
	const sentDeals: {
		key: string;
		priceJpy: number;
		at: string;
		tier: string;
	}[] = [];
	let notifiedCount = 0;
	for (const it of final) {
		if (!it.tier) continue;
		const key = dealKey(it);
		const last = notifiedMap[key];
		if (!shouldNotify(it, key, last, env.now)) continue;
		dealEmbeds.push(buildDealEmbed(it, { seller: sellerById.get(it.id) }));
		sentDeals.push({
			key,
			priceJpy: it.totalJpy,
			at: env.now.toISOString(),
			tier: it.tier,
		});
		notifiedCount++;
	}

	const allEmbeds = [...newsEmbeds, ...dealEmbeds, ...healthEmbeds];
	if (notifier && allEmbeds.length > 0 && !dryRun) {
		await notifier.send(allEmbeds);
	}

	// 8. 永続化(dryRunなら何も書かない)。lastRuns/rssSeen/verifyQueueは実行前スナップショット
	// (state)ではなく直前に再読込したstateにマージする — sweep/verify中にfliブレーカ等が
	// 直接writeStateしている可能性があり、そちらを上書きしないため。
	if (!dryRun) {
		store.appendFares(runObservations);
		store.writeDeals(final);
		for (const d of sentDeals) {
			store.appendNotified({
				dealKey: d.key,
				priceJpy: d.priceJpy,
				at: d.at,
				tier: d.tier,
			});
		}
		const latest = store.readState();
		store.writeState({
			...latest,
			lastRuns: nextLastRuns,
			rssSeen: nextRssSeen,
			verifyQueue: nextVerifyQueue,
		});
		store.writeHealth(health);
	}

	return {
		jobsRun,
		observations: runObservations.length,
		notified: notifiedCount,
		errors,
	};
}

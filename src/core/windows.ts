import type { Config, FeedConf, WindowConf } from "../config";
import type { RunnerEnv } from "../sources/types";

export type Job =
	| { id: `window:${string}`; kind: "window"; window: WindowConf; caps: [] }
	| { id: `rss:${string}`; kind: "rss"; feed: FeedConf; caps: [] }
	| {
			id: "deep-sweep";
			kind: "deep-sweep";
			everyMinutes: number;
			caps: ["browser"];
	  }
	| {
			id: "verify-queue";
			kind: "verify-queue";
			everyMinutes: 30;
			caps: ["browser"];
	  };

function windowJob(w: WindowConf): Job {
	return { id: `window:${w.name}`, kind: "window", window: w, caps: [] };
}

function rssJob(f: FeedConf): Job {
	return { id: `rss:${f.name}`, kind: "rss", feed: f, caps: [] };
}

// 全ジョブ定義: 窓×N + RSSフィード×N + 深掃引(1) + 検証キュー(1)。
// 深掃引/検証キューはbrowser能力を要求するため、CI(Actions)では常にdueJobs側で除外される。
export function allJobs(cfg: Config): Job[] {
	return [
		...cfg.windows.map(windowJob),
		...cfg.rss_feeds.map(rssJob),
		{
			id: "deep-sweep",
			kind: "deep-sweep",
			everyMinutes: cfg.browser.deep_sweep_every_hours * 60,
			caps: ["browser"],
		},
		{
			id: "verify-queue",
			kind: "verify-queue",
			everyMinutes: 30,
			caps: ["browser"],
		},
	];
}

function everyMinutesOf(job: Job): number {
	switch (job.kind) {
		case "window":
			return job.window.every_minutes;
		case "rss":
			return job.feed.every_minutes;
		case "deep-sweep":
		case "verify-queue":
			return job.everyMinutes;
	}
}

// 現状唯一の能力タグは"browser"。caps非空 = browser要求とみなす。
function requiresBrowser(job: Job): boolean {
	return job.caps.length > 0;
}

// due条件: lastRunなし or (now - lastRun) ≥ every_minutes。
// capsを満たさないランナー（hasBrowser=false下のbrowser要求ジョブ）は対象外。
export function dueJobs(
	jobs: Job[],
	lastRuns: Record<string, string>,
	env: RunnerEnv,
): Job[] {
	return jobs.filter((job) => {
		if (requiresBrowser(job) && !env.hasBrowser) return false;
		const lastRun = lastRuns[job.id];
		if (lastRun === undefined) return true;
		const elapsedMs = env.now.getTime() - new Date(lastRun).getTime();
		return elapsedMs >= everyMinutesOf(job) * 60_000;
	});
}

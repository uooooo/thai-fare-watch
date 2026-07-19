import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { allJobs, dueJobs } from "../src/core/windows";

const cfg = loadConfig({ env: {} });
const envCI = {
	isCI: true,
	hasBrowser: false,
	now: new Date("2026-07-18T10:00:00Z"),
};
const envLocal = { ...envCI, isCI: false, hasBrowser: true };

describe("windows scheduler", () => {
	test("allJobsはwindow2+rss2+deep-sweep+verify-queueを生成", () => {
		expect(
			allJobs(cfg)
				.map((j): string => j.id)
				.sort(),
		).toEqual(
			[
				"deep-sweep",
				"rss:sky-budget",
				"rss:traicy-sale",
				"verify-queue",
				"window:immediate",
				"window:near",
			].sort(),
		);
	});
	test("lastRunが新しい窓はdueにならない", () => {
		const last = {
			"window:immediate": "2026-07-18T09:45:00Z",
			"window:near": "2026-07-18T08:00:00Z",
		};
		const ids = dueJobs(allJobs(cfg), last, envCI).map((j) => j.id);
		expect(ids).not.toContain("window:immediate"); // 15分前 < 30分
		expect(ids).toContain("window:near"); // 120分前 ≥ 60分
	});
	test("browser能力ジョブはCIで対象外・ローカルで対象", () => {
		expect(dueJobs(allJobs(cfg), {}, envCI).map((j) => j.id)).not.toContain(
			"deep-sweep",
		);
		expect(dueJobs(allJobs(cfg), {}, envLocal).map((j) => j.id)).toContain(
			"deep-sweep",
		);
	});
});

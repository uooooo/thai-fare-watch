import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { renderPlist } from "../src/cli";

describe("renderPlist", () => {
	test("bun絶対パス・リポジトリパス・1800秒間隔を含む", () => {
		const p = renderPlist({
			bunPath: "/opt/bun",
			repoDir: "/repo",
			logDir: "/logs",
		});
		expect(p).toContain("<string>/repo/scripts/watch-and-sync.sh</string>");
		expect(p).toContain("<integer>1800</integer>");
		expect(p).toContain("tech.incerto.tfw");
		expect(p).toContain("/logs/tfw.log");
	});

	test("RunAtLoadがtrueで有効化されている", () => {
		const p = renderPlist({
			bunPath: "/opt/bun",
			repoDir: "/repo",
			logDir: "/logs",
		});
		expect(p).toContain("<key>RunAtLoad</key>");
		expect(p).toContain("<true/>");
	});

	test("有効なplist XML(DOCTYPE+plistルート要素)である", () => {
		const p = renderPlist({
			bunPath: "/opt/bun",
			repoDir: "/repo",
			logDir: "/logs",
		});
		expect(p).toContain('<?xml version="1.0" encoding="UTF-8"?>');
		expect(p).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
		expect(p).toContain('<plist version="1.0">');
		expect(p).toContain("<dict>");
		expect(p).toContain("</dict>");
		expect(p).toContain("</plist>");
	});

	test("bunPathのディレクトリがPATHに含まれる(bunコマンド解決の防御)", () => {
		const p = renderPlist({
			bunPath: "/opt/mise/bun/bin/bun",
			repoDir: "/repo",
			logDir: "/logs",
		});
		expect(p).toContain("/opt/mise/bun/bin");
	});
});

async function runCli(args: string[], env: Record<string, string> = {}) {
	const p = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
		env: {
			...process.env,
			TFW_DATA_DIR: mkdtempSync(join(tmpdir(), "tfw-")),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("tfw setup-local --dry-run", () => {
	test("plistをstdoutに出力し、実HOME配下のLaunchAgentsには一切書き込まない", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "tfw-home-"));
		const r = await runCli(["setup-local", "--dry-run"], { HOME: fakeHome });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("tech.incerto.tfw");
		expect(r.stdout).toContain("<integer>1800</integer>");
		expect(r.stdout).toContain("scripts/watch-and-sync.sh");

		// dry-runはファイルシステムに一切書き込まない(fakeHome配下・実HOME配下いずれも)。
		expect(existsSync(join(fakeHome, "Library", "LaunchAgents"))).toBe(false);
		expect(existsSync(join(fakeHome, "Library", "Logs", "tfw"))).toBe(false);
		expect(
			existsSync(
				join(homedir(), "Library", "LaunchAgents", "tech.incerto.tfw.plist"),
			),
		).toBe(false);
	});
});

#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ArgsDef, CommandDef } from "citty";
import { defineCommand, renderUsage, runMain } from "citty";
import { type Config, loadConfig, maskedConfig } from "./config";
import { buildPairs, marketOf, runWatchOnce } from "./core/pipeline";
import { DiscordNotifier } from "./notify/discord";
import { RssSignal } from "./signals/rss";
import { buildSources } from "./sources/index";
import type { RunnerEnv } from "./sources/types";
import { Store } from "./state/store";
import type {
	DateRange,
	FareObservation,
	OdPair,
	VerifiedOffer,
} from "./types";
import { windowToRange } from "./util/dates";
import { safeErrorMessage } from "./util/http";

// 全サブコマンド共通のflag。post-subcommand（`tfw <cmd> [--json ...]`）順で渡すことを前提にする
// —citty はサブコマンド名より前のflagをそのサブコマンドへ引き渡さないため、コマンド表(spec 6.11)
// 通りの書式にも一致する。
const GLOBAL_ARGS = {
	json: { type: "boolean", description: "機械可読なJSON出力(agent向け)" },
	config: {
		type: "string",
		description: "設定ファイルパス(既定: cwdのtfw.config.toml)",
	},
	"dry-run": {
		type: "boolean",
		description: "通知送信・永続化を行わない",
	},
} satisfies ArgsDef;

type GlobalFlags = { json: boolean; config?: string; dryRun: boolean };

function globalFlags(args: {
	json?: boolean;
	config?: string;
	"dry-run"?: boolean;
}): GlobalFlags {
	return {
		json: Boolean(args.json),
		config: args.config,
		dryRun: Boolean(args["dry-run"]),
	};
}

// setup()内で読み込んだConfig.secretsを保持する(コマンドごとに新規プロセスなので実質
// 「今回の実行のcfg.secrets」)。setup()より前にfail()する経路(FROM/TO/DATE必須チェック等)では
// 未設定のままだが、そちら側のメッセージは元々秘密を含まない静的文言のみ。
let activeSecrets: Config["secrets"] | undefined;

// cfg.secretsの非空な値をtextから探し、出現箇所を全て"***"に置換する。http.tsのredactUrl
// (URL構造を前提にクエリ値/webhookトークンを伏せる根本対策)に対する多重防御 —Discord webhook
// のようにURL全体が秘密になるケースや、http.tsを経由しない将来のエラーメッセージにも効く、
// このCLIにとっての最後の網。
export function redactSecrets(
	text: string,
	secrets: Config["secrets"],
): string {
	let out = text;
	for (const value of Object.values(secrets)) {
		if (value) out = out.split(value).join("***");
	}
	return out;
}

// このCLIが出すエラー文字列は必ずこれを通す(activeSecrets未設定時は素通し)。
function redact(text: string): string {
	return activeSecrets ? redactSecrets(text, activeSecrets) : text;
}

// safeErrorMessage(http.ts)で生Error/HttpErrorのいずれでも秘密URLを構造的にscrub/redact
// した上で、既存のredactSecrets(cfg.secretsの生値と完全一致するリテラル)を多重防御として
// さらに適用する。根本対策(safeErrorMessage)→CLI固有の網(redact)の順で必ず両方通す。
function errMsg(err: unknown): string {
	return redact(safeErrorMessage(err));
}

// 想定内の失敗(webhook未設定・引数不足・能力ゼロ等)を運ぶ専用エラー。
// process.exit()は使わない —piped stdoutをexit前に強制終了すると出力が途中で切れる恐れがある
// (console.log等の書き込みが完了する前にプロセスが終了しうる)。代わりにexitCodeを設定して
// 関数を正常return させ、イベントループが自然に空になるのを待ってからプロセスを終了させる。
class CliFailure extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}
function fail(message: string, exitCode = 1): never {
	throw new CliFailure(message, exitCode);
}

// 各コマンドのcatch節から呼ぶ。CliFailureはそのメッセージのみをstderrへ(呼び出し側が
// 既に"cmd: "接頭辞を含めている)。それ以外の想定外例外は"cmd: "を前置してexit 1にする。
function handleFailure(name: string, err: unknown): void {
	if (err instanceof CliFailure) {
		process.stderr.write(`${redact(err.message)}\n`);
		process.exitCode = err.exitCode;
		return;
	}
	process.stderr.write(`${name}: ${errMsg(err)}\n`);
	process.exitCode = 1;
}

// 共通セットアップ: loadConfig(--config)・Store(TFW_DATA_DIR優先)・RunnerEnvを構築する。
// 各コマンドはこれを呼んでからcoreの薄い皮として振る舞う。
function setup(configPath: string | undefined): {
	cfg: Config;
	store: Store;
	env: RunnerEnv;
} {
	const cfg = loadConfig({ path: configPath, env: process.env });
	// 以降このプロセス内のerrMsg/handleFailure/redact呼び出し全てが、実際に読み込んだ秘密の値を
	// マスク対象にできるようにする(defense-in-depth。根本対策はhttp.tsのredactUrl)。
	activeSecrets = cfg.secrets;
	const store = new Store(process.env.TFW_DATA_DIR ?? "data");
	const env: RunnerEnv = {
		isCI: !!process.env.CI,
		hasBrowser: !process.env.CI && cfg.browser.enabled !== false,
		now: new Date(),
	};
	return { cfg, store, env };
}

// sweepの対象期間。--window指定時はその窓のfrom/to、未指定時は全窓を包含する範囲(最小from〜最大to)。
function resolveSweepRange(
	cfg: Config,
	windowName: string | undefined,
	now: Date,
): DateRange {
	if (cfg.windows.length === 0) throw new Error("no windows configured");
	if (windowName !== undefined) {
		const w = cfg.windows.find((x) => x.name === windowName);
		if (!w) {
			const names = cfg.windows.map((x) => x.name).join(", ");
			throw new Error(`unknown window "${windowName}" (available: ${names})`);
		}
		return windowToRange(w.from, w.to, now);
	}
	const from = Math.min(...cfg.windows.map((w) => w.from));
	const to = Math.max(...cfg.windows.map((w) => w.to));
	return windowToRange(from, to, now);
}

const watchCmd = defineCommand({
	meta: {
		name: "watch",
		description:
			"期限が来た窓+RSS+検証キューの全パイプライン実行（launchd/Actions共通エントリ）",
	},
	args: {
		once: { type: "boolean", description: "1回だけ実行(現状の唯一のモード)" },
		...GLOBAL_ARGS,
	},
	async run({ args }) {
		const { json, config, dryRun } = globalFlags(args);
		const once = Boolean(args.once);
		try {
			const { cfg, store, env } = setup(config);
			const sources = buildSources(cfg, store, env, { dryRun });
			const rss = new RssSignal(cfg);
			const webhook = cfg.secrets.discordWebhookUrl;
			const notifier = webhook ? new DiscordNotifier(webhook) : undefined;
			const result = await runWatchOnce({
				cfg,
				store,
				env,
				sources,
				rss,
				notifier,
				dryRun,
			});
			// --onceの有無に関わらず常に1回だけ実行する（継続モードは未実装）。省略時はその旨を
			// stderrへ(--jsonのstdout純度を保つため、ヒントはstdoutへは絶対に混ぜない)。
			if (!once) {
				process.stderr.write(
					"watch: continuous mode is not implemented yet; ran once (equivalent to --once). Use `tfw setup-local`/cron/launchd to repeat.\n",
				);
			}
			// result.errorsはpipeline.ts側で組み立てられた文字列で、このモジュールのerrMsgを経由
			// していないため、stdout/stderrへ出す直前にここで明示的にredact()を通す
			// (--jsonのstdoutにも秘密を絶対に出さないための多重防御)。
			const safeErrors = result.errors.map((e) => redact(e));
			if (json) {
				console.log(JSON.stringify({ ...result, errors: safeErrors }));
			} else {
				console.log(`jobs run: ${result.jobsRun.length}`);
				for (const id of result.jobsRun) console.log(`  - ${id}`);
				console.log(`observations: ${result.observations}`);
				console.log(`notified: ${result.notified}`);
				console.log(`errors: ${safeErrors.length}`);
				for (const e of safeErrors) console.log(`  - ${e}`);
			}
			process.exitCode = result.errors.length > 0 ? 2 : 0;
		} catch (err) {
			handleFailure("watch", err);
		}
	},
});

const sweepCmd = defineCommand({
	meta: {
		name: "sweep",
		description:
			"掃引/スキャンのみ（--deepでGFブラウザ日付グリッド掃引を強制）",
	},
	args: {
		window: {
			type: "string",
			description: "掃引する窓の名前(既定: 全窓の合成範囲)",
		},
		deep: {
			type: "boolean",
			description: "GFブラウザ(gf-browser)の日付グリッド掃引のみを強制する",
		},
		...GLOBAL_ARGS,
	},
	async run({ args }) {
		const { json, config, dryRun } = globalFlags(args);
		const deep = Boolean(args.deep);
		try {
			const { cfg, store, env } = setup(config);
			const range = resolveSweepRange(cfg, args.window, env.now);
			const pairs = buildPairs(cfg);
			const sources = buildSources(cfg, store, env, { dryRun });
			const sweepSources = sources.filter(
				(s) =>
					s.sweep && s.available(env) && (!deep || s.name === "gf-browser"),
			);

			const observations: FareObservation[] = [];
			const errors: string[] = [];
			for (const source of sweepSources) {
				try {
					observations.push(...((await source.sweep?.(pairs, range)) ?? []));
				} catch (err) {
					errors.push(`${source.name}: ${errMsg(err)}`);
				}
			}

			if (json) {
				console.log(JSON.stringify({ observations }));
			} else if (observations.length === 0) {
				console.log("sweep: (0 observations)");
			} else {
				console.table(observations);
			}
			for (const e of errors) process.stderr.write(`sweep: ${redact(e)}\n`);
			process.exitCode = errors.length > 0 ? 2 : 0;
		} catch (err) {
			handleFailure("sweep", err);
		}
	},
});

const verifyCmd = defineCommand({
	meta: {
		name: "verify",
		description:
			"指定区間を即時検証（--sellersで販売元まで: ローカル=GFブラウザ/Actions=SerpAPI）",
	},
	args: {
		from: { type: "positional", required: false, description: "出発地コード" },
		to: { type: "positional", required: false, description: "到着地コード" },
		date: { type: "positional", required: false, description: "YYYY-MM-DD" },
		sellers: {
			type: "boolean",
			description: "販売元ソース(gf-browser/serpapi)まで検証する",
		},
		...GLOBAL_ARGS,
	},
	async run({ args }) {
		const { json, config, dryRun } = globalFlags(args);
		// fail()呼び出しは必ずtry内で行う —try外で投げるとcittyのrunMain既定ハンドラ
		// (console.error(error,"\n")+process.exit(1))に渡ってしまい、スタックトレース混みの
		// 出力になってhandleFailureの整形が効かない。
		try {
			const { from, to, date } = args;
			if (!from || !to || !date) {
				fail(
					"verify: FROM, TO, DATE are required (tfw verify <FROM> <TO> <DATE> [--sellers])",
				);
			}
			const { cfg, store, env } = setup(config);
			const sources = buildSources(cfg, store, env, { dryRun });
			const od: OdPair = {
				origin: from,
				destination: to,
				market: marketOf(from),
			};

			const fli = sources.find(
				(s) => s.name === "fli" && s.verify && s.available(env),
			);
			if (!fli?.verify) {
				fail(
					"verify: no price source available (fli is disabled or unavailable)",
				);
			}
			const offers: VerifiedOffer[] = [...(await fli.verify(od, date))];

			if (args.sellers) {
				const sellerSource =
					sources.find(
						(s) => s.name === "gf-browser" && s.verify && s.available(env),
					) ??
					sources.find(
						(s) => s.name === "serpapi" && s.verify && s.available(env),
					);
				if (sellerSource?.verify) {
					// 販売元確認はベストエフォート —失敗してもfliで得た価格情報は返す(コマンド全体を
					// 失敗させない)。fli自体の失敗(上のfli?.verify呼び出し)はコマンドの主目的が
					// 果たせないため致命的だが、--sellersはあくまで付加情報という位置づけ。
					try {
						offers.push(...(await sellerSource.verify(od, date)));
					} catch (err) {
						process.stderr.write(
							`verify: ${sellerSource.name}: ${errMsg(err)}\n`,
						);
					}
				} else {
					process.stderr.write(
						"verify: --sellers requested but no seller-capable source is available (gf-browser/serpapi)\n",
					);
				}
			}

			if (json) {
				console.log(JSON.stringify({ offers }));
			} else if (offers.length === 0) {
				console.log("verify: (no offers found)");
			} else {
				console.table(offers);
			}
			process.exitCode = 0;
		} catch (err) {
			handleFailure("verify", err);
		}
	},
});

const dealsCmd = defineCommand({
	meta: { name: "deals", description: "現在の有効deal一覧" },
	args: { ...GLOBAL_ARGS },
	async run({ args }) {
		const { json, config } = globalFlags(args);
		try {
			const { store } = setup(config);
			const deals = store.readDeals();
			if (json) {
				console.log(JSON.stringify({ deals }));
			} else if (deals.length === 0) {
				console.log("deals: (0)");
			} else {
				console.table(deals);
			}
			process.exitCode = 0;
		} catch (err) {
			handleFailure("deals", err);
		}
	},
});

const historyCmd = defineCommand({
	meta: { name: "history", description: "価格履歴（JSONL集計）" },
	args: {
		from: { type: "positional", required: false, description: "出発地コード" },
		to: { type: "positional", required: false, description: "到着地コード" },
		...GLOBAL_ARGS,
	},
	async run({ args }) {
		const { json, config } = globalFlags(args);
		// fail()呼び出しは必ずtry内で行う(verifyコマンドと同じ理由)。
		try {
			const { from, to } = args;
			if (!from || !to) {
				fail("history: FROM and TO are required (tfw history <FROM> <TO>)");
			}
			const { store, env } = setup(config);
			// 直近45日分のfares/*.jsonlをFROM→TO(大文字小文字は無視)で絞り込む。airport/city正規化
			// (NRT/HND→TYO等)は行わない —永続観測のorigin/destinationはcfg.origins等と同じ表記の
			// はずなので、その通りに指定してもらう前提(spec上の航空都市コードの粒度に依存)。
			const fares = store.readRecentFares(24 * 45, env.now);
			const matched = fares.filter(
				(o) =>
					o.origin.toUpperCase() === from.toUpperCase() &&
					o.destination.toUpperCase() === to.toUpperCase(),
			);
			const minByDate = new Map<string, number>();
			for (const o of matched) {
				const prev = minByDate.get(o.departDate);
				if (prev === undefined || o.priceJpy < prev)
					minByDate.set(o.departDate, o.priceJpy);
			}
			const history = [...minByDate.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([departDate, minPriceJpy]) => ({ departDate, minPriceJpy }));

			if (json) {
				console.log(JSON.stringify({ history }));
			} else if (history.length === 0) {
				console.log("history: (0)");
			} else {
				console.table(history);
			}
			process.exitCode = 0;
		} catch (err) {
			handleFailure("history", err);
		}
	},
});

const newsCmd = defineCommand({
	meta: { name: "news", description: "RSSセール速報の直近マッチ一覧" },
	args: { ...GLOBAL_ARGS },
	async run({ args }) {
		const { json, config } = globalFlags(args);
		try {
			// --configを他コマンドと同様に一貫して尊重するため、setup()を呼ぶ(以前は無条件に
			// 既定値のみを見ており--configを黙って無視していた)。news自体はcfg/store/envを
			// 使わないため戻り値は捨てる。
			setup(config);
			// state.rssSeenは既読guidの集合のみを保持し、タイトル/URL等の本文は保存しない(store.ts参照)。
			// そのため復元可能なニュースは常に0件 —"追跡できていない"旨をstderrにのみ書き、
			// stdoutは(--json時に)常に純粋な{news:[]}のみにする。
			process.stderr.write(
				"news: state only retains RSS guids (not titles/bodies), so nothing can be listed here yet.\n",
			);
			console.log(json ? JSON.stringify({ news: [] }) : "news: (0 tracked)");
			process.exitCode = 0;
		} catch (err) {
			handleFailure("news", err);
		}
	},
});

const quotaCmd = defineCommand({
	meta: { name: "quota", description: "SerpAPIクォータ残量（キー設定時のみ）" },
	args: { ...GLOBAL_ARGS },
	async run({ args }) {
		const { json, config } = globalFlags(args);
		try {
			const { cfg, store } = setup(config);
			const enabled = Boolean(cfg.secrets.serpapiKey);
			if (!enabled) {
				console.log(
					json
						? JSON.stringify({ enabled })
						: "quota: SERPAPI_API_KEY未設定(無効)",
				);
				process.exitCode = 0;
				return;
			}
			const q = store.readQuota();
			console.log(
				json
					? JSON.stringify({ enabled, ...q })
					: `quota: ${q.month} used=${q.used}/${cfg.serpapi.monthly_quota}`,
			);
			process.exitCode = 0;
		} catch (err) {
			handleFailure("quota", err);
		}
	},
});

const notifyTestCmd = defineCommand({
	meta: { name: "notify-test", description: "Discordテスト送信" },
	args: { ...GLOBAL_ARGS },
	async run({ args }) {
		const { json, config } = globalFlags(args);
		try {
			const { cfg } = setup(config);
			const webhook = cfg.secrets.discordWebhookUrl;
			if (!webhook) fail("notify-test: DISCORD_WEBHOOK_URL is not set");
			const notifier = new DiscordNotifier(webhook);
			await notifier.send([
				{
					title: "tfw notify-test",
					description: "tfw notify-test からのテスト通知です。",
					color: 0x0a84ff,
				},
			]);
			console.log(
				json ? JSON.stringify({ ok: true }) : "ok: テスト通知を送信しました",
			);
			process.exitCode = 0;
		} catch (err) {
			handleFailure("notify-test", err);
		}
	},
});

const configCmd = defineCommand({
	meta: { name: "config", description: "解決済み設定の表示（秘密はマスク）" },
	args: { ...GLOBAL_ARGS },
	async run({ args }) {
		const { json, config } = globalFlags(args);
		try {
			const { cfg } = setup(config);
			const masked = maskedConfig(cfg);
			console.log(
				json ? JSON.stringify(masked) : JSON.stringify(masked, null, 2),
			);
			process.exitCode = 0;
		} catch (err) {
			handleFailure("config", err);
		}
	},
});

// launchdのLabel。plistファイル名(~/Library/LaunchAgents/<LABEL>.plist)にも使う。
const LAUNCHD_LABEL = "tech.incerto.tfw";
// watch-and-syncを30分毎に起動する(spec/T16のStartInterval、秒単位)。
const LAUNCHD_INTERVAL_SEC = 1800;

// launchd plist本文を組み立てる純関数(副作用なし)。setup-local(--dry-run含む)から呼ぶ。
// bunPathはEnvironmentVariables.PATHへ反映する—watch-and-sync.sh自身もPATHへbunを通すため
// 実行上は冗長防御だが、launchdはデフォルトで最小限のPATHしか渡さないため二重に効かせておく。
export function renderPlist(opts: {
	bunPath: string;
	repoDir: string;
	logDir: string;
}): string {
	const scriptPath = join(opts.repoDir, "scripts", "watch-and-sync.sh");
	const logPath = join(opts.logDir, "tfw.log");
	const bunDir = dirname(opts.bunPath);
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${scriptPath}</string>
	</array>
	<key>StartInterval</key>
	<integer>${LAUNCHD_INTERVAL_SEC}</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${logPath}</string>
	<key>StandardErrorPath</key>
	<string>${logPath}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${bunDir}:/opt/homebrew/bin:/usr/bin:/bin</string>
	</dict>
</dict>
</plist>
`;
}

const setupLocalCmd = defineCommand({
	meta: {
		name: "setup-local",
		description: "launchd plist生成+ロード（30分毎実行、ログパス設定込み）",
	},
	args: {
		uninstall: {
			type: "boolean",
			description:
				"launchd登録を解除しplistを削除する（--dry-runと併用すると解除内容の確認のみ）",
		},
		...GLOBAL_ARGS,
	},
	async run({ args }) {
		const { dryRun } = globalFlags(args);
		// process.getuidはPOSIX限定(Windowsはundefined)。launchdはmacOS専有機能なので、
		// 万一undefinedでも例外にせずtsc上だけ安全に倒す(実行時はmacOS前提で必ず値が入る)。
		const domain = `gui/${process.getuid?.() ?? 0}`;
		const plistPath = join(
			homedir(),
			"Library",
			"LaunchAgents",
			`${LAUNCHD_LABEL}.plist`,
		);
		try {
			if (args.uninstall) {
				if (dryRun) {
					// --dry-run --uninstallもfs/launchctlに一切触れない(表示のみ、通常のdry-runと同じ契約)。
					console.log(
						`(dry-run) launchctl bootout ${domain} ${plistPath} && rm ${plistPath}`,
					);
					process.exitCode = 0;
					return;
				}
				try {
					execFileSync("launchctl", ["bootout", domain, plistPath], {
						stdio: "ignore",
					});
				} catch {
					// 既に未登録(bootout失敗)でも、plist削除は続行する(冪等)。
				}
				if (existsSync(plistPath)) rmSync(plistPath);
				console.log(`ok: launchd登録を解除しました (${plistPath})`);
				process.exitCode = 0;
				return;
			}

			const bunPath = process.execPath;
			// import.meta.dirは常に"<repoDir>/src"(このファイルの場所)なので、そこから1段上る。
			const repoDir = dirname(import.meta.dir);
			const logDir =
				process.env.TFW_LOG_DIR ?? join(homedir(), "Library", "Logs", "tfw");
			const plist = renderPlist({ bunPath, repoDir, logDir });

			if (dryRun) {
				// --dry-runはファイルシステム(plist書き込み・ログディレクトリ作成・launchctl呼び出し)
				// に一切触れず、生成結果をstdoutへ出すだけにする(spec通り「表示のみ」)。
				console.log(plist);
				process.exitCode = 0;
				return;
			}

			mkdirSync(logDir, { recursive: true });
			mkdirSync(dirname(plistPath), { recursive: true });
			writeFileSync(plistPath, plist);
			// 既に登録済みの場合のbootstrap再実行はエラーになりうるため、先にbootout(失敗は無視)
			// してから改めてbootstrapする—setup-localを再実行しても安全な冪等操作にする。
			try {
				execFileSync("launchctl", ["bootout", domain, plistPath], {
					stdio: "ignore",
				});
			} catch {
				// 未登録だった場合は失敗して当然なので無視する。
			}
			execFileSync("launchctl", ["bootstrap", domain, plistPath]);
			console.log(`ok: launchd登録しました (${plistPath})`);
			process.exitCode = 0;
		} catch (err) {
			handleFailure("setup-local", err);
		}
	},
});

const main = defineCommand({
	meta: {
		name: "tfw",
		description: "Thai Fare Watch — タイ行き格安直行/経由航空券ウォッチャーCLI",
	},
	subCommands: {
		watch: watchCmd,
		sweep: sweepCmd,
		verify: verifyCmd,
		deals: dealsCmd,
		history: historyCmd,
		news: newsCmd,
		quota: quotaCmd,
		"notify-test": notifyTestCmd,
		config: configCmd,
		"setup-local": setupLocalCmd,
	},
});

// citty既定のshowUsageはUSAGE本文をconsole.log(...)でSTDOUTへ書く。未知サブコマンド等の
// CLIError発生時にrunMainがこれを呼ぶため、既定のままだと`tfw bogus --json`のようなagent向け
// 呼び出しでも整形済みUSAGE本文がSTDOUTへ混ざってしまう(--jsonのstdout純度契約に反する)。
// runMainのshowUsage差し替えフックを使い、USAGE本文を必ずSTDERRへ書くようにする —
// これで--help時もエラー時もSTDOUTは実行結果専用のまま保たれる。
async function showUsageOnStderr<T extends ArgsDef = ArgsDef>(
	cmd: CommandDef<T>,
	parent?: CommandDef<T>,
): Promise<void> {
	try {
		process.stderr.write(`${await renderUsage(cmd, parent)}\n`);
	} catch (err) {
		process.stderr.write(`${errMsg(err)}\n`);
	}
}

// import.meta.mainガード: このファイルが直接実行された(`bun run src/cli.ts ...`/`tfw`bin)場合
// のみCLIを起動する。テストからexport(redactSecrets等)をimportするだけではCLIが起動しない
// ようにするため(importするだけでprocess.argvをコマンドとして解釈・実行してしまうと事故る)。
if (import.meta.main) {
	await runMain(main, { showUsage: showUsageOnStderr });
}

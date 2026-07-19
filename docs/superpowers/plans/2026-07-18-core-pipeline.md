# thai-fare-watch コアパイプライン Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 東京→タイ片道の格安経路（直行/経由/別切り/国内ポジショニング）を多層ソースで監視し、信頼できる販売元の価格だけをDiscordに通知するbot+CLIを動かす。

**Architecture:** `tfw` CLI（bun/TS）が全機能のコア。ソースはアダプタ登録制（Travelpayouts / fli / SerpAPI / Google Flightsブラウザ）で、窓スケジューラが期限の来たジョブだけ実行する。状態は `data/` のJSON/JSONLをgitで同期（ローカルlaunchd + GitHub Actionsの二重ランナー）。検証は unverified → price_confirmed → verified の段階昇格で、verifiedのみ🔥/💥通知。

**Tech Stack:** bun 1.3+ / TypeScript strict / citty / zod v4 / smol-toml / fast-xml-parser / Playwright(実Chrome) / bun:test / Biome / GitHub Actions

**参照spec:** `docs/superpowers/specs/2026-07-18-thai-fare-watch-design.md`（本プランと齟齬があればspecが正）

**別プラン:** webダッシュボード（spec §6.13）は本プラン完了後に `docs/superpowers/plans/` に別途作成する。

## Global Constraints

- ランタイムは bun（Node不使用）。テストは `bun:test`。パッケージ追加は `bun add`。
- TypeScript strict。型は `src/types.ts` の定義を全タスクで使う（重複定義禁止）。
- 金額はすべて整数JPY。日付は `YYYY-MM-DD`（JST基準）、時刻はISO8601文字列。
- 秘密情報（`DISCORD_WEBHOOK_URL`, `TRAVELPAYOUTS_TOKEN`, `SERPAPI_API_KEY`）はコード・fixture・コミットに絶対に含めない。`.env`（gitignore済）と GitHub Secrets のみ。**plan/specにも値を書かない。**
- 外部APIはテストで実際に叩かない（fixture + fetchモック）。GFブラウザはCIで起動しない。
- コミットメッセージは conventional commits（feat:/fix:/test:/docs:/chore:）。各タスク末尾で必ずコミット。
- CLIの全コマンドは `--json` 対応、終了コード 0=成功/1=致命的/2=部分失敗。
- 通知ティア: 💥flash(≤10,000, verified) / 🔥deal(≤15,000, verified) / ⚠️candidate(≤15,000, 未検証) / ℹ️sale-news。

## File Structure

```
thai-fare-watch/
├── package.json / tsconfig.json / biome.json / .gitignore / .env.example
├── tfw.config.toml              # 非秘密の既定設定（コミット対象）
├── src/
│   ├── cli.ts                   # cittyエントリ（bin: tfw）
│   ├── config.ts                # TOML+env読込・zod検証・既定値
│   ├── types.ts                 # 共有型（FareObservation等）
│   ├── util/dates.ts            # JST日付・窓→日付範囲
│   ├── util/http.ts             # fetchJson(retry/timeout/backoff)
│   ├── util/hash.ts             # 安定ID生成
│   ├── state/store.ts           # data/ のJSON/JSONL読み書き
│   ├── sources/types.ts         # FareSource IF・RunnerEnv
│   ├── sources/index.ts         # アダプタ登録・available()解決
│   ├── sources/travelpayouts.ts
│   ├── sources/fli.ts           # uvxサブプロセス+CB
│   ├── sources/serpapi.ts       # 検索+Booking Options+クォータ
│   ├── sources/gf-browser/parse.ts   # 純関数パーサ（fixtureテスト対象）
│   ├── sources/gf-browser/index.ts   # Playwright操作
│   ├── signals/rss.ts
│   ├── core/trust.ts
│   ├── core/combiner.ts
│   ├── core/dedupe.ts           # ティア判定+再通知抑制
│   ├── core/windows.ts          # ジョブスケジューラ
│   ├── core/verify.ts           # 検証パイプライン
│   ├── core/pipeline.ts         # watch統合
│   └── notify/discord.ts
├── scripts/
│   ├── watch-and-sync.sh        # pull→watch→commit&push（launchd/手動用）
│   └── record-gf-fixture.ts     # GF DOMスナップショット採取
├── skills/thai-fare-watch/SKILL.md
├── AGENTS.md / CLAUDE.md / README.md
├── data/.gitkeep                # 実データはランナーが生成しコミット
├── test/                        # *.test.ts と fixtures/
└── .github/workflows/{ci.yml, watch.yml}
```

**オーケストレータ事前作業（サブエージェント開始前に完了させる）:** リポジトリ直下に `.env` を作成し `DISCORD_WEBHOOK_URL=<会話で受領した値>` を書く（gitignore対象）。値は本ドキュメントに書かない。

---

### Task 1: スキャフォールドとGitHub公開

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `.env.example`, `data/.gitkeep`, `test/smoke.test.ts`

**Interfaces:**
- Produces: `bun test` が動く土台。GitHub repo `uooooo/thai-fare-watch`（public）と Secrets `DISCORD_WEBHOOK_URL`。

- [ ] **Step 1: bun初期化と依存追加**

```bash
cd /Users/akafuda/ghq/github.com/uooooo/thai-fare-watch
bun init -y
bun add citty zod smol-toml fast-xml-parser
bun add -d @biomejs/biome bun-types typescript
bunx biome init
```

- [ ] **Step 2: 設定ファイルを以下の内容で作成**

`package.json` を編集（bun initの生成物に対し以下のキーを設定。既存キーは維持）:

```json
{
  "name": "thai-fare-watch",
  "type": "module",
  "bin": { "tfw": "./src/cli.ts" },
  "scripts": {
    "tfw": "bun run src/cli.ts",
    "test": "bun test",
    "check": "biome check ."
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "scripts"]
}
```

`.gitignore`:

```
node_modules/
.env
*.log
dist/
test/fixtures/gf-live/
```

`.env.example`:

```
DISCORD_WEBHOOK_URL=
TRAVELPAYOUTS_TOKEN=
SERPAPI_API_KEY=
```

`test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";

test("smoke", () => {
  expect(1 + 1).toBe(2);
});
```

`data/.gitkeep` は空ファイル。

- [ ] **Step 3: テストとlintが通ることを確認**

Run: `bun test && bunx biome check .`
Expected: smoke 1 pass、biomeエラー0（警告はbiome.jsonの既定に従う）

- [ ] **Step 4: コミットしてGitHubへ公開**

```bash
git add -A
git commit -m "chore: bun+TS+Biomeスキャフォールド"
gh repo create uooooo/thai-fare-watch --public --source=. --push \
  --description "東京→タイ片道の格安航空券監視bot (browser-first hybrid)"
```

- [ ] **Step 5: Secretsを設定（.envから読む。値を表示しない）**

```bash
set -a; source .env; set +a
gh secret set DISCORD_WEBHOOK_URL --body "$DISCORD_WEBHOOK_URL"
```

Expected: `✓ Set Actions secret DISCORD_WEBHOOK_URL`（TRAVELPAYOUTS/SERPAPIはキー入手後に同手順）

---

### Task 2: 共有型と日付ユーティリティ

**Files:**
- Create: `src/types.ts`, `src/util/dates.ts`, `src/util/hash.ts`
- Test: `test/dates.test.ts`, `test/hash.test.ts`

**Interfaces:**
- Produces（全タスクが依存。**この定義が唯一の正**）:

```ts
// src/types.ts — 全文
export type FareObservation = {
  id: string;
  source: "gf-browser" | "fli" | "travelpayouts" | "serpapi" | (string & {});
  origin: string;              // IATA都市/空港コード（大文字）
  destination: string;
  departDate: string;          // YYYY-MM-DD（現地）
  departAt?: string;           // ISO8601
  arriveAt?: string;
  airline?: string;            // 2レターor名称
  flightNumber?: string;
  transfers: number;           // 単一予約内の乗継数
  priceJpy: number;            // 整数JPY（手数料含まず）
  market: string;              // "jp" | "kr" | ...
  foundAt: string;             // ISO8601
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
  from: string;                // "TYO"
  to: string;                  // 空港/都市コード
  priceJpy: number;
  hours: number;
};

export type Leg = FareObservation | GroundLeg;
export const isGround = (l: Leg): l is GroundLeg => (l as GroundLeg).kind === "ground";

export type Verification = "unverified" | "price_confirmed" | "partial" | "verified";
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
};

export type DateRange = { from: string; to: string }; // 両端含む YYYY-MM-DD
export type OdPair = { origin: string; destination: string; market: string };
```

```ts
// src/util/dates.ts — 公開シグネチャ
export function todayJst(now?: Date): string;                       // "2026-07-18"
export function addDays(date: string, days: number): string;
export function windowToRange(fromOffset: number, toOffset: number, now?: Date): DateRange;
export function datesInRange(range: DateRange): string[];           // 両端含む列挙
export function hoursBetween(isoA: string, isoB: string): number;   // b - a（小数可）
export function monthsTouched(range: DateRange): string[];          // ["2026-07","2026-08"]
```

```ts
// src/util/hash.ts
export function stableId(...parts: (string | number | undefined)[]): string; // 短いhex
```

- [ ] **Step 1: 失敗するテストを書く** — `test/dates.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { addDays, datesInRange, hoursBetween, monthsTouched, todayJst, windowToRange } from "../src/util/dates";

describe("dates (JST)", () => {
  // 2026-07-18T20:00:00Z = JSTでは 2026-07-19 05:00
  const now = new Date("2026-07-18T20:00:00Z");
  test("todayJstはUTC日付でなくJST日付を返す", () => {
    expect(todayJst(now)).toBe("2026-07-19");
  });
  test("windowToRange immediate(0..1)", () => {
    expect(windowToRange(0, 1, now)).toEqual({ from: "2026-07-19", to: "2026-07-20" });
  });
  test("addDaysは月跨ぎ可", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
  });
  test("datesInRangeは両端含む", () => {
    expect(datesInRange({ from: "2026-07-30", to: "2026-08-01" })).toEqual([
      "2026-07-30", "2026-07-31", "2026-08-01",
    ]);
  });
  test("hoursBetweenはタイムゾーン込みで計算", () => {
    expect(hoursBetween("2026-08-02T10:00:00+09:00", "2026-08-02T16:30:00+07:00")).toBe(8.5);
  });
  test("monthsTouched", () => {
    expect(monthsTouched({ from: "2026-07-19", to: "2026-08-18" })).toEqual(["2026-07", "2026-08"]);
  });
});
```

`test/hash.test.ts`:

```ts
import { expect, test } from "bun:test";
import { stableId } from "../src/util/hash";

test("同入力→同ID、異入力→異ID", () => {
  const a = stableId("TYO", "BKK", "2026-08-02", 12345);
  expect(a).toBe(stableId("TYO", "BKK", "2026-08-02", 12345));
  expect(a).not.toBe(stableId("TYO", "BKK", "2026-08-03", 12345));
  expect(a).toMatch(/^[0-9a-f]{12}$/);
});
```

- [ ] **Step 2: 失敗を確認** — Run: `bun test test/dates.test.ts test/hash.test.ts` / Expected: FAIL（モジュール未定義）

- [ ] **Step 3: 実装**（types.tsは上記全文、datesはIntlでJST化）:

```ts
// src/util/dates.ts
import type { DateRange } from "../types";

const JST_FMT = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

export function todayJst(now: Date = new Date()): string {
  return JST_FMT.format(now); // sv-SE => YYYY-MM-DD
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function windowToRange(fromOffset: number, toOffset: number, now?: Date): DateRange {
  const base = todayJst(now);
  return { from: addDays(base, fromOffset), to: addDays(base, toOffset) };
}
export function datesInRange(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}
export function hoursBetween(isoA: string, isoB: string): number {
  return (new Date(isoB).getTime() - new Date(isoA).getTime()) / 3_600_000;
}
export function monthsTouched(range: DateRange): string[] {
  const out = new Set<string>();
  for (const d of datesInRange(range)) out.add(d.slice(0, 7));
  return [...out];
}
```

```ts
// src/util/hash.ts
export function stableId(...parts: (string | number | undefined)[]): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(parts.map((p) => String(p ?? "")).join("\u0000")); // NUL区切り: 空白入りパーツ("XJ 601"等)でも連結衝突しない
  return h.digest("hex").slice(0, 12);
}
```

- [ ] **Step 4: パス確認** — Run: `bun test` / Expected: 全pass
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: 共有型とJST日付/ハッシュユーティリティ"`

---

### Task 3: 設定モジュール

**Files:**
- Create: `src/config.ts`, `tfw.config.toml`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `src/types.ts`
- Produces:

```ts
export type WindowConf = { name: string; from: number; to: number; every_minutes: number };
export type FeedConf = { name: string; url: string; every_minutes: number };
export type GroundConf = { to: string; mode: "train" | "bus"; priceJpy: number; hours: number };
export type Config = {
  origins: string[]; positioning: string[]; hubs: string[]; destinations: string[];
  thresholds: { notify_max: number; flash_max: number; watch_margin: number };
  windows: WindowConf[];
  trusted_otas: string[];
  fx_fee_rate: number;
  combine: { min_connect_hours: number; max_connect_hours: number; allow_next_day: boolean; max_total_hours: number };
  browser: { enabled: "auto" | boolean; min_interval_sec: number; jitter_sec: number; deep_sweep_every_hours: number; headless: boolean; channel: string };
  fli: { enabled: boolean; ci_circuit_breaker: { consecutive_failures: number; cooldown_hours: number } };
  serpapi: { monthly_quota: number; daily_budget_cap: number };
  rss_feeds: FeedConf[];
  rss_keywords: { places: string[]; airlines: string[]; context: string[] };
  ground: GroundConf[];
  secrets: { discordWebhookUrl?: string; travelpayoutsToken?: string; serpapiKey?: string };
};
export function loadConfig(opts?: { path?: string; env?: Record<string, string | undefined> }): Config;
export function maskedConfig(c: Config): unknown; // secretsを"***"化したJSON表現
```

- [ ] **Step 1: `tfw.config.toml` を作成**（specの既定値そのまま。これが実運用設定の起点）:

```toml
origins = ["TYO"]
positioning = ["OSA", "NGO", "FUK", "OKA"]
hubs = ["SEL", "TPE", "KUL", "SGN", "SIN", "HKG", "MNL"]
destinations = ["BKK", "CNX", "HKT"]
trusted_otas = ["trip.com", "booking.com"]
fx_fee_rate = 0.022

[thresholds]
notify_max = 15000
flash_max = 10000
watch_margin = 1.2

[[windows]]
name = "immediate"
from = 0
to = 1
every_minutes = 30

[[windows]]
name = "near"
from = 2
to = 31
every_minutes = 60

[combine]
min_connect_hours = 4
max_connect_hours = 26
allow_next_day = true
max_total_hours = 40

[browser]
enabled = "auto"
min_interval_sec = 45
jitter_sec = 20
deep_sweep_every_hours = 3
headless = true
channel = "chrome"

[fli]
enabled = true
[fli.ci_circuit_breaker]
consecutive_failures = 3
cooldown_hours = 6

[serpapi]
monthly_quota = 250
daily_budget_cap = 8

[[rss_feeds]]
name = "traicy-sale"
url = "https://www.traicy.com/category/airline/sale/feed"
every_minutes = 60

[[rss_feeds]]
name = "sky-budget"
url = "https://sky-budget.com/feed/"
every_minutes = 120

[rss_keywords]
places = ["タイ", "バンコク", "プーケット", "チェンマイ", "ドンムアン", "スワンナプーム"]
airlines = ["エアアジア", "ZIPAIR", "ジップエア", "スクート", "ベトジェット", "ピーチ", "ジェットスター", "タイ・ライオン・エア", "AirAsia", "Scoot", "VietJet", "Peach"]
context = ["セール", "アジア", "国際線", "タイムセール", "片道"]

# 東京都心→空港の地上アクセス（最安目安。新幹線でKIXは¥14,500だが夜行バス既定）
[[ground]]
to = "NRT"
mode = "bus"
priceJpy = 1500
hours = 1.5

[[ground]]
to = "HND"
mode = "train"
priceJpy = 600
hours = 0.5

[[ground]]
to = "OSA"
mode = "bus"
priceJpy = 6000
hours = 9.0

[[ground]]
to = "NGO"
mode = "bus"
priceJpy = 4000
hours = 6.0
```

- [ ] **Step 2: 失敗するテスト** — `test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig, maskedConfig } from "../src/config";

describe("config", () => {
  test("リポジトリ既定のtfw.config.tomlが読める", () => {
    const c = loadConfig({ env: {} });
    expect(c.hubs).toContain("SEL");
    expect(c.thresholds.notify_max).toBe(15000);
    expect(c.windows.map((w) => w.name)).toEqual(["immediate", "near"]);
    expect(c.ground.find((g) => g.to === "HND")?.priceJpy).toBe(600);
  });
  test("envから秘密を拾い、maskedConfigで漏らさない", () => {
    const c = loadConfig({ env: { DISCORD_WEBHOOK_URL: "https://discord.example/x", TRAVELPAYOUTS_TOKEN: "tp-secret" } });
    expect(c.secrets.discordWebhookUrl).toBe("https://discord.example/x");
    const masked = JSON.stringify(maskedConfig(c));
    expect(masked).not.toContain("tp-secret");
    expect(masked).not.toContain("discord.example");
  });
  test("空文字envはundefined扱い（Actionsの未設定Secrets対策）", () => {
    const c = loadConfig({ env: { SERPAPI_API_KEY: "" } });
    expect(c.secrets.serpapiKey).toBeUndefined();
  });
  test("壊れた値はzodが弾く", () => {
    expect(() => loadConfig({ path: "test/fixtures/bad-config.toml", env: {} })).toThrow();
  });
});
```

`test/fixtures/bad-config.toml`:

```toml
[thresholds]
notify_max = "やすい"
```

- [ ] **Step 3: 失敗確認** — Run: `bun test test/config.test.ts` / Expected: FAIL
- [ ] **Step 4: 実装** — `smol-toml` の `parse` でTOML読込 → zodスキーマ（上記Config型と同形、`browser.enabled` は `z.union([z.literal("auto"), z.boolean()])`）→ `.default(...)` で全既定値を埋める（TOML欠落キーは既定にフォールバック。ファイル自体が無くても既定のみで動く）。env読込は `opts.env ?? process.env`、空文字は `undefined` に正規化。`maskedConfig` は `secrets` の存在キーを `"***"` に置換した深いコピーを返す。
- [ ] **Step 5: パス確認とコミット** — `bun test` 全pass → `git add -A && git commit -m "feat: TOML+env設定ローダ(zod検証・秘密マスク)"`

---

### Task 4: HTTPユーティリティと状態ストア

**Files:**
- Create: `src/util/http.ts`, `src/state/store.ts`
- Test: `test/http.test.ts`, `test/store.test.ts`

**Interfaces:**
- Produces:

```ts
// src/util/http.ts
export class HttpError extends Error { constructor(public status: number, public url: string, body?: string); }
export function fetchJson<T = unknown>(url: string, init?: RequestInit & {
  timeoutMs?: number;          // 既定15000
  retries?: number;            // 既定3（429/5xx/ネットワークエラーのみ）
  fetchImpl?: typeof fetch;    // テスト注入用
}): Promise<T>;
export function fetchText(url: string, init?: /* 同上 */): Promise<string>;

// src/state/store.ts  — すべて同期IO（bun）。data/はコンストラクタ引数で差替可（テスト用）
export type StateFile = {
  lastRuns: Record<string, string>;          // jobId -> ISO8601
  rssSeen: Record<string, string[]>;         // feed -> guid[]（直近200件で切詰め）
  breakers: Record<string, { openUntil?: string; failures: number }>;
  verifyQueue: string[];                     // Itinerary.id（ローカル昇格待ち）
};
export class Store {
  constructor(dataDir?: string);             // 既定 "data"
  readState(): StateFile;                    // 無ければ空既定
  writeState(s: StateFile): void;
  appendFares(obs: FareObservation[]): void; // data/fares/YYYY-MM.jsonl（obs.foundAtの月）
  readRecentFares(hours: number, now?: Date): FareObservation[]; // 当月+前月から絞込
  readDeals(): Itinerary[];
  writeDeals(deals: Itinerary[]): void;
  readQuota(): { month: string; used: number };
  writeQuota(q: { month: string; used: number }): void;
  appendNotified(entry: object): void;       // data/notified.jsonl
  readNotified(): Record<string, { priceJpy: number; at: string; tier: string }>; // dealKey -> 最新
  readHealth(): Record<string, SourceHealth>;
  writeHealth(h: Record<string, SourceHealth>): void;
}
```

- [ ] **Step 1: 失敗するテスト** — `test/http.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { HttpError, fetchJson } from "../src/util/http";

function seq(responses: Array<() => Response>): typeof fetch {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]!()) as unknown as typeof fetch;
}

describe("fetchJson", () => {
  test("200でJSONを返す", async () => {
    const f = seq([() => Response.json({ ok: 1 })]);
    expect(await fetchJson("https://x/", { fetchImpl: f })).toEqual({ ok: 1 });
  });
  test("429→200はリトライで成功", async () => {
    const f = seq([() => new Response("slow down", { status: 429 }), () => Response.json({ ok: 2 })]);
    expect(await fetchJson("https://x/", { fetchImpl: f, retries: 2 })).toEqual({ ok: 2 });
  });
  test("404は即HttpError（リトライしない）", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("nf", { status: 404 }); }) as unknown as typeof fetch;
    await expect(fetchJson("https://x/", { fetchImpl: f })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });
});
```

`test/store.test.ts`（`fs.mkdtempSync` の一時dirで全メソッドを往復検証）:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store";
import type { FareObservation } from "../src/types";

const obs = (over: Partial<FareObservation>): FareObservation => ({
  id: "x", source: "travelpayouts", origin: "TYO", destination: "BKK",
  departDate: "2026-08-02", transfers: 0, priceJpy: 14000, market: "jp",
  foundAt: new Date().toISOString(), ...over,
});

describe("Store", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "tfw-"));
  test("stateは無ければ空既定・書けば読める", () => {
    const s = new Store(dir());
    expect(s.readState().lastRuns).toEqual({});
    s.writeState({ ...s.readState(), lastRuns: { "window:near": "2026-07-18T00:00:00Z" } });
    expect(s.readState().lastRuns["window:near"]).toBe("2026-07-18T00:00:00Z");
  });
  test("faresは月別JSONLに追記され、readRecentFaresが期限で絞る", () => {
    const s = new Store(dir());
    const fresh = obs({ id: "a" });
    const stale = obs({ id: "b", foundAt: new Date(Date.now() - 72 * 3600e3).toISOString() });
    s.appendFares([fresh, stale]);
    const got = s.readRecentFares(48);
    expect(got.map((o) => o.id)).toEqual(["a"]);
  });
  test("quota既定は当月used=0", () => {
    const s = new Store(dir());
    expect(s.readQuota().used).toBe(0);
  });
  test("notifiedは同キーの最新を返す", () => {
    const s = new Store(dir());
    s.appendNotified({ dealKey: "k1", priceJpy: 14000, at: "2026-07-18T00:00:00Z", tier: "deal" });
    s.appendNotified({ dealKey: "k1", priceJpy: 13000, at: "2026-07-18T06:00:00Z", tier: "deal" });
    expect(s.readNotified()["k1"]?.priceJpy).toBe(13000);
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/http.test.ts test/store.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — http: `AbortSignal.timeout(timeoutMs)`、リトライは `429 || status>=500 || fetch例外` のみ、待機 `min(2^attempt * 500 + rand(250), 8000)`ms。store: `Bun.file`/`Bun.write`+`node:fs`（appendFileSync, mkdirSync recursive）。JSONLは1行1JSON。`readRecentFares` は `monthsTouched` で当月・前月ファイルだけ読む。`readNotified` は全行を後勝ちでreduce。
- [ ] **Step 4: パス確認** — `bun test` 全pass
- [ ] **Step 5: Commit** — `git commit -am "feat: リトライ付きfetchとdata/状態ストア"`

---

### Task 5: Travelpayoutsアダプタ

**Files:**
- Create: `src/sources/types.ts`, `src/sources/travelpayouts.ts`
- Test: `test/travelpayouts.test.ts`, `test/fixtures/tp-prices-for-dates.json`

**Interfaces:**
- Consumes: `fetchJson`, `Config`, `types.ts`
- Produces:

```ts
// src/sources/types.ts
export type RunnerEnv = { isCI: boolean; hasBrowser: boolean; now: Date };
export interface FareSource {
  name: string;
  available(env: RunnerEnv): boolean;
  sweep?(pairs: OdPair[], range: DateRange): Promise<FareObservation[]>;
  verify?(od: OdPair, date: string): Promise<VerifiedOffer[]>;
}

// src/sources/travelpayouts.ts
export class TravelpayoutsSource implements FareSource {
  name = "travelpayouts";
  constructor(cfg: Config, deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> });
  available(env: RunnerEnv): boolean;   // tokenがある時のみtrue
  sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]>;
}
```

- [ ] **Step 1: fixtureを実API形状で作成** — `test/fixtures/tp-prices-for-dates.json`（v3 prices_for_datesの文書化形状。値はダミー）:

```json
{
  "success": true,
  "currency": "jpy",
  "data": [
    {
      "origin": "TYO", "destination": "BKK",
      "origin_airport": "NRT", "destination_airport": "DMK",
      "price": 14980, "airline": "XJ", "flight_number": "601",
      "departure_at": "2026-08-02T09:15:00+09:00",
      "transfers": 0, "duration_to": 420, "link": "/search/NRT0208BKK1"
    },
    {
      "origin": "TYO", "destination": "BKK",
      "origin_airport": "HND", "destination_airport": "BKK",
      "price": 25800, "airline": "TG", "flight_number": "683",
      "departure_at": "2026-08-05T00:20:00+09:00",
      "transfers": 1, "duration_to": 610, "link": "/search/HND0508BKK1"
    }
  ]
}
```

- [ ] **Step 2: 失敗するテスト** — `test/travelpayouts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { TravelpayoutsSource } from "../src/sources/travelpayouts";
import fixture from "./fixtures/tp-prices-for-dates.json";

const cfg = loadConfig({ env: { TRAVELPAYOUTS_TOKEN: "tp-test" } });
const env = { isCI: true, hasBrowser: false, now: new Date("2026-07-18T00:00:00Z") };

describe("TravelpayoutsSource", () => {
  test("tokenが無ければavailable=false", () => {
    const s = new TravelpayoutsSource(loadConfig({ env: {} }));
    expect(s.available(env)).toBe(false);
  });
  test("sweepはURLにtoken/market/currency/月を含め、FareObservationへ変換", async () => {
    const urls: string[] = [];
    const f = (async (u: RequestInfo | URL) => { urls.push(String(u)); return Response.json(fixture); }) as unknown as typeof fetch;
    const s = new TravelpayoutsSource(cfg, { fetchImpl: f, sleep: async () => {} });
    const got = await s.sweep(
      [{ origin: "TYO", destination: "BKK", market: "jp" }, { origin: "SEL", destination: "BKK", market: "kr" }],
      { from: "2026-08-01", to: "2026-08-31" },
    );
    expect(urls[0]).toContain("origin=TYO");
    expect(urls[0]).toContain("market=jp");
    expect(urls[0]).toContain("currency=jpy");
    expect(urls[0]).toContain("departure_at=2026-08");
    expect(urls[0]).toContain("one_way=true");
    expect(urls[1]).toContain("market=kr");
    const o = got[0]!;
    expect(o.source).toBe("travelpayouts");
    expect(o.priceJpy).toBe(14980);
    expect(o.departDate).toBe("2026-08-02");
    expect(o.departAt).toBe("2026-08-02T09:15:00+09:00");
    expect(o.market).toBe("jp");
    expect(o.expiresAt).toBeDefined();
    expect(o.id).toMatch(/^[0-9a-f]{12}$/);
  });
  test("範囲外の日付・successでない応答は捨てる", async () => {
    const f = (async () => Response.json({ success: true, data: fixture.data })) as unknown as typeof fetch;
    const s = new TravelpayoutsSource(cfg, { fetchImpl: f, sleep: async () => {} });
    const got = await s.sweep([{ origin: "TYO", destination: "BKK", market: "jp" }], { from: "2026-08-03", to: "2026-08-31" });
    expect(got.map((o) => o.departDate)).toEqual(["2026-08-05"]); // 08-02は範囲外
  });
});
```

- [ ] **Step 3: 失敗確認** — Run: `bun test test/travelpayouts.test.ts` / Expected: FAIL
- [ ] **Step 4: 実装** — エンドポイント `https://api.travelpayouts.com/aviasales/v3/prices_for_dates`。ペア×`monthsTouched(range)`ごとに `departure_at=YYYY-MM&one_way=true&direct=false&currency=jpy&market=<pair.market>&limit=1000&sorting=price&token=<secret>` をGET（呼び出し間に `sleep(150)`）。変換: `departDate = departure_at.slice(0,10)`（範囲内のみ採用）、`foundAt = now.toISOString()`、`expiresAt = +48h`、`airline`/`flight_number`/`transfers ?? 0`、`origin_airport`があればoriginに空港コードを使い、都市コードは`origin`フィールドへフォールバック。id は `stableId("tp", origin, destination, departDate, flightNumber, priceJpy)`。個別ペアの失敗はwarnして継続（全滅時のみthrow）。
- [ ] **Step 5: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: Travelpayouts掃引アダプタ(市場別JPY照会)"`

---

### Task 6: fliアダプタ（uvxサブプロセス+サーキットブレーカ）

**Files:**
- Create: `src/sources/fli.ts`
- Test: `test/fli.test.ts`, `test/fixtures/fli-search.json`（Step 1で採取した実出力を整形）

**Interfaces:**
- Consumes: `FareSource`, `Config`, `Store`（ブレーカ状態）
- Produces:

```ts
export class FliSource implements FareSource {
  name = "fli";
  constructor(cfg: Config, deps: {
    run?: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>; // 既定: Bun.spawn("uvx --from fli-search fli ..." 相当)
    breaker?: { isOpen(): boolean; recordFailure(): void; recordSuccess(): void };
  });
  available(env: RunnerEnv): boolean;  // enabled && !breaker.isOpen()
  sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]>;   // 日付範囲最安スキャン
  verify(od: OdPair, date: string): Promise<VerifiedOffer[]>;            // sellers: []
}
export function makeCiBreaker(store: Store, cfg: Config, env: RunnerEnv): { isOpen(): boolean; recordFailure(): void; recordSuccess(): void };
```

- [ ] **Step 1: fliのCLI契約を確定して記録する（コード前の必須調査）**

```bash
# READMEで正確なパッケージ名/コマンド/JSONフラグを確認（punitarani/fli）
curl -s https://raw.githubusercontent.com/punitarani/fli/main/README.md | head -120
# ローカルで実行し、実出力を採取（片道・JPY・日本POSのオプションを README記載どおりに指定）
uvx --from <READMEのpip名> fli <search系コマンド> NRT BKK <日付指定> <JSON出力フラグ> | tee /tmp/fli-out.json
```

採取した実出力から**代表2件program分**を `test/fixtures/fli-search.json` に保存し、ファイル冒頭コメントは付けず、`test/fli.test.ts` 内の定数 `FLI_ARGS`（実際に使う引数配列）をREADME確認結果で確定させる。**このステップの成果物: fixture + 確定済み引数**。日付範囲スキャン（`search_dates`相当のコマンド）が存在すればsweepはそれを使い、無ければ `datesInRange` の日毎検索でエミュレートする（この分岐もここで確定させ、テストに反映）。

- [ ] **Step 2: 失敗するテスト** — `test/fli.test.ts`（runモックで契約検証。fixtureパース+ブレーカ遷移）:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { FliSource } from "../src/sources/fli";

const cfg = loadConfig({ env: {} });
const fixture = await Bun.file("test/fixtures/fli-search.json").text();

const okRun = async () => ({ exitCode: 0, stdout: fixture, stderr: "" });
const failRun = async () => ({ exitCode: 1, stdout: "", stderr: "blocked" });
const mkBreaker = () => {
  let failures = 0; let open = false;
  return {
    isOpen: () => open,
    recordFailure: () => { if (++failures >= 3) open = true; },
    recordSuccess: () => { failures = 0; },
  };
};

describe("FliSource", () => {
  test("verifyはFareObservation(sellers=[])を返す", async () => {
    const s = new FliSource(cfg, { run: okRun, breaker: mkBreaker() });
    const got = await s.verify({ origin: "NRT", destination: "BKK", market: "jp" }, "2026-08-02");
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]!.sellers).toEqual([]);
    expect(got[0]!.source).toBe("fli");
    expect(got[0]!.priceJpy).toBeGreaterThan(0);
  });
  test("3連続失敗でブレーカが開きavailable=false", async () => {
    const breaker = mkBreaker();
    const s = new FliSource(cfg, { run: failRun, breaker });
    const env = { isCI: true, hasBrowser: false, now: new Date() };
    for (let i = 0; i < 3; i++) await s.verify({ origin: "NRT", destination: "BKK", market: "jp" }, "2026-08-02").catch(() => {});
    expect(s.available(env)).toBe(false);
  });
});
```

- [ ] **Step 3: 失敗確認** — Run: `bun test test/fli.test.ts` / Expected: FAIL
- [ ] **Step 4: 実装** — 既定 `run` は `Bun.spawn(["uvx", "--from", <確定名>, "fli", ...FLI_ARGS], { stdout: "pipe", stderr: "pipe" })` + 30sタイムアウト。パースはStep 1で確定した実形状に対して書く（価格・出発/到着時刻・便名・航空会社・乗継数をFareObservationへ。JPY指定で叩くので価格はそのまま整数化）。exitCode≠0/パース不能は `recordFailure()` してthrow、成功時 `recordSuccess()`。`makeCiBreaker` は `store.readState().breakers["fli"]` を読み書きし、CI環境のみ `openUntil = now + cooldown_hours` を設定（ローカルは常に閉）。
- [ ] **Step 5: ローカル実スモーク（コミット前に1回）** — Run: `bun run -e 'const {FliSource}=await import("./src/sources/fli");const {loadConfig}=await import("./src/config");const s=new FliSource(loadConfig({env:process.env}),{});console.log((await s.verify({origin:"NRT",destination:"BKK",market:"jp"},"<30日後の日付>")).slice(0,2))'`
Expected: 実価格が2件表示（ブロック時はヘルス方針どおりエラーになることを確認しfixtureテストのみで先へ進む。スモーク結果をコミットメッセージに記録）
- [ ] **Step 6: Commit** — `git commit -am "feat: fliアダプタ(uvxサブプロセス, CIサーキットブレーカ)"`

---

### Task 7: SerpAPIアダプタとクォータ管理

**Files:**
- Create: `src/sources/serpapi.ts`
- Test: `test/serpapi.test.ts`, `test/fixtures/serpapi-search.json`, `test/fixtures/serpapi-booking-options.json`

**Interfaces:**
- Consumes: `fetchJson`, `Store`（quota）, `Config`
- Produces:

```ts
export class QuotaManager {
  constructor(store: Store, cfg: Config, now?: Date);
  remainingMonth(): number;
  dailyBudget(): number;                 // min(remaining/残日数(切上げ), daily_budget_cap)
  tryConsume(n: number): boolean;        // 予算内ならused加算しtrue
}
export class SerpApiSource implements FareSource {
  name = "serpapi";
  constructor(cfg: Config, deps: { store: Store; fetchImpl?: typeof fetch; now?: Date });
  available(env: RunnerEnv): boolean;    // key有り かつ 当日予算>0
  verify(od: OdPair, date: string): Promise<VerifiedOffer[]>; // 検索1+対象便のbooking options 1
}
```

- [ ] **Step 1: fixtures作成**（SerpAPI文書の実形状・値はダミー）— `test/fixtures/serpapi-search.json`:

```json
{
  "best_flights": [
    {
      "flights": [{
        "departure_airport": { "id": "NRT", "time": "2026-08-02 09:15" },
        "arrival_airport": { "id": "DMK", "time": "2026-08-02 14:10" },
        "airline": "Thai AirAsia X", "flight_number": "XJ 601"
      }],
      "price": 14980, "total_duration": 415, "booking_token": "bt-abc"
    }
  ],
  "other_flights": [
    {
      "flights": [
        { "departure_airport": { "id": "NRT", "time": "2026-08-02 10:00" }, "arrival_airport": { "id": "TPE", "time": "2026-08-02 13:00" }, "airline": "Scoot", "flight_number": "TR 899" },
        { "departure_airport": { "id": "TPE", "time": "2026-08-02 15:00" }, "arrival_airport": { "id": "BKK", "time": "2026-08-02 18:00" }, "airline": "Scoot", "flight_number": "TR 866" }
      ],
      "price": 18200, "total_duration": 540, "booking_token": "bt-def"
    }
  ]
}
```

`test/fixtures/serpapi-booking-options.json`:

```json
{
  "booking_options": [
    { "together": { "book_with": "ZIPAIR", "airline": true, "price": 14980, "booking_request": { "url": "https://www.zipair.net/..." } } },
    { "together": { "book_with": "Trip.com", "airline": false, "price": 15100, "booking_request": { "url": "https://trip.com/..." } } },
    { "together": { "book_with": "Gotogate", "airline": false, "price": 13900, "booking_request": { "url": "https://gotogate.example/..." } } }
  ]
}
```

- [ ] **Step 2: 失敗するテスト** — `test/serpapi.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { QuotaManager, SerpApiSource } from "../src/sources/serpapi";
import { Store } from "../src/state/store";
import search from "./fixtures/serpapi-search.json";
import booking from "./fixtures/serpapi-booking-options.json";

const cfg = loadConfig({ env: { SERPAPI_API_KEY: "sa-test" } });
const now = new Date("2026-07-18T03:00:00Z");
const store = () => new Store(mkdtempSync(join(tmpdir(), "tfw-")));

describe("QuotaManager", () => {
  test("日次予算 = min(残/残日数, cap)", () => {
    const st = store();
    st.writeQuota({ month: "2026-07", used: 200 });
    const q = new QuotaManager(st, cfg, now); // 残50, 7月残14日 → ceil(50/14)=4
    expect(q.dailyBudget()).toBe(4);
  });
  test("tryConsumeは月上限で拒否", () => {
    const st = store();
    st.writeQuota({ month: "2026-07", used: 249 });
    const q = new QuotaManager(st, cfg, now);
    expect(q.tryConsume(2)).toBe(false);
    expect(q.tryConsume(1)).toBe(true);
    expect(st.readQuota().used).toBe(250);
  });
  test("月が替わるとリセット", () => {
    const st = store();
    st.writeQuota({ month: "2026-06", used: 250 });
    expect(new QuotaManager(st, cfg, now).remainingMonth()).toBe(250);
  });
});

describe("SerpApiSource", () => {
  test("verifyは検索+booking optionsでsellers付きofferを返す", async () => {
    const urls: string[] = [];
    const f = (async (u: RequestInfo | URL) => {
      const url = String(u); urls.push(url);
      return Response.json(url.includes("booking_token") ? booking : search);
    }) as unknown as typeof fetch;
    const s = new SerpApiSource(cfg, { store: store(), fetchImpl: f, now });
    const got = await s.verify({ origin: "NRT", destination: "BKK", market: "jp" }, "2026-08-02");
    expect(urls[0]).toContain("engine=google_flights");
    expect(urls[0]).toContain("currency=JPY");
    expect(urls[0]).toContain("gl=jp");
    expect(urls[0]).toContain("type=2"); // 片道
    const best = got.find((o) => o.flightNumber === "XJ 601")!;
    expect(best.sellers.map((s) => s.seller)).toEqual(["ZIPAIR", "Trip.com", "Gotogate"]);
    expect(best.sellers[0]!.isAirlineDirect).toBe(true);
  });
  test("booking optionsは最安便のみ（クォータ節約）で、quotaが2消費される", async () => {
    const st = store();
    const f = (async (u: RequestInfo | URL) =>
      Response.json(String(u).includes("booking_token") ? booking : search)) as unknown as typeof fetch;
    const s = new SerpApiSource(cfg, { store: st, fetchImpl: f, now });
    await s.verify({ origin: "NRT", destination: "BKK", market: "jp" }, "2026-08-02");
    expect(st.readQuota().used).toBe(2);
  });
  test("予算切れならavailable=false", () => {
    const st = store();
    st.writeQuota({ month: "2026-07", used: 250 });
    const s = new SerpApiSource(cfg, { store: st, now });
    expect(s.available({ isCI: true, hasBrowser: false, now })).toBe(false);
  });
});
```

- [ ] **Step 3: 失敗確認** — Run: `bun test test/serpapi.test.ts` / Expected: FAIL
- [ ] **Step 4: 実装** — 検索: `https://serpapi.com/search.json?engine=google_flights&departure_id=<origin>&arrival_id=<destination>&outbound_date=<date>&type=2&currency=JPY&gl=jp&hl=ja&api_key=<key>`（都市コードTYO/BKK/SELはGoogle対応: TYOはNRT,HND連結、BKKはBKK,DMK連結、その他はそのまま。変換表を`const CITY_AIRPORTS`で持つ）。`best_flights`+`other_flights` を統合し FareObservation化（`time` は `"YYYY-MM-DD HH:MM"` → ISO+09:00…ではなく現地時刻のオフセット不明のため `departAt` はローカル時刻文字列に`Z`を付けず素のまま保持しない — **仕様: departAt/arriveAtは `YYYY-MM-DDTHH:MM` のオフセットなし文字列として保存し、hoursBetween比較は同一空港ペア内のみで使う**）。booking optionsは配列先頭（=応答の最安）1便のみ `&booking_token=` 付きで再取得し、その便のsellersに変換（`together.book_with`/`airline`/`price`/`booking_request.url`）。`tryConsume(1)`を各fetch前に呼び、falseなら `QuotaExceededError` をthrow（呼び元がcandidate降格）。verify全体で消費は最大2。
- [ ] **Step 5: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: SerpAPIフォールバック検証(クォータ自己管理付き)"`

---

### Task 8: RSSシグナル

**Files:**
- Create: `src/signals/rss.ts`
- Test: `test/rss.test.ts`, `test/fixtures/traicy-sale.xml`

**Interfaces:**
- Consumes: `fetchText`, `Config`, `Store`
- Produces:

```ts
export function matchSaleNews(title: string, kw: Config["rss_keywords"]): string[]; // マッチしたキーワード（空=不一致）
export class RssSignal {
  constructor(cfg: Config, deps?: { fetchImpl?: typeof fetch });
  poll(feed: FeedConf, seenGuids: string[]): Promise<{ news: SaleNews[]; seen: string[] }>;
  // newsは新規マッチのみ。seenは更新後のguidリスト（最大200）
}
```

- [ ] **Step 1: fixture作成** — `test/fixtures/traicy-sale.xml`（WordPress RSS2の実形状・3 item）:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>TRAICY セール</title>
  <item>
    <title>エアアジア、日本〜バンコク線含む国際線でセール 片道7,900円から</title>
    <link>https://www.traicy.com/posts/2026071801</link>
    <guid isPermaLink="false">https://www.traicy.com/?p=1001</guid>
    <pubDate>Sat, 18 Jul 2026 09:00:00 +0900</pubDate>
  </item>
  <item>
    <title>ジェットスター、国内線全路線でセール 片道1,990円から</title>
    <link>https://www.traicy.com/posts/2026071802</link>
    <guid isPermaLink="false">https://www.traicy.com/?p=1002</guid>
    <pubDate>Sat, 18 Jul 2026 08:00:00 +0900</pubDate>
  </item>
  <item>
    <title>ZIPAIR、成田〜バンコク線 タイムセール</title>
    <link>https://www.traicy.com/posts/2026071803</link>
    <guid isPermaLink="false">https://www.traicy.com/?p=1003</guid>
    <pubDate>Sat, 18 Jul 2026 07:00:00 +0900</pubDate>
  </item>
</channel></rss>
```

- [ ] **Step 2: 失敗するテスト** — `test/rss.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { RssSignal, matchSaleNews } from "../src/signals/rss";

const cfg = loadConfig({ env: {} });
const xml = await Bun.file("test/fixtures/traicy-sale.xml").text();

describe("matchSaleNews", () => {
  test("タイ地名でマッチ", () => {
    expect(matchSaleNews("エアアジア、日本〜バンコク線含む国際線でセール", cfg.rss_keywords)).toContain("バンコク");
  });
  test("航空会社名のみ（国際文脈なし・国内線）は不一致", () => {
    expect(matchSaleNews("ジェットスター、国内線全路線でセール 片道1,990円から", cfg.rss_keywords)).toEqual([]);
  });
});

describe("RssSignal.poll", () => {
  const feed = { name: "traicy-sale", url: "https://x/feed", every_minutes: 60 };
  const f = (async () => new Response(xml)) as unknown as typeof fetch;
  test("新規マッチのみ返し、既読guidは返さない", async () => {
    const sig = new RssSignal(cfg, { fetchImpl: f });
    const r1 = await sig.poll(feed, []);
    expect(r1.news.map((n) => n.guid)).toEqual(["https://www.traicy.com/?p=1001", "https://www.traicy.com/?p=1003"]);
    const r2 = await sig.poll(feed, r1.seen);
    expect(r2.news).toEqual([]);
  });
});
```

- [ ] **Step 3: 失敗確認** — Run: `bun test test/rss.test.ts` / Expected: FAIL
- [ ] **Step 4: 実装** — `fast-xml-parser` の `XMLParser`（`ignoreAttributes: false`）。item→`SaleNews`（guidは`guid["#text"] ?? guid ?? link`）。マッチ規則（specどおり）: `places` のいずれかを含む → その語を返す。または `airlines` のいずれか **かつ** `context` のいずれかを含む → 両方返す（「ジェットスター…国内線」は context に「国際線」等が無いため不一致になるが「セール」は含む — **順序修正: airlines+contextルールは context のうち「セール」を除いた語（アジア/国際線/片道/タイムセール）で判定する**。テスト期待値がこの仕様を固定する）。`seen` は既存+新規を先頭優先で200件に切詰め。
- [ ] **Step 5: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: セール速報RSSシグナル(キーワードマッチ+既読管理)"`

---

### Task 9: 信頼フィルタ

**Files:**
- Create: `src/core/trust.ts`
- Test: `test/trust.test.ts`

**Interfaces:**
- Consumes: `SellerOffer`, `Config`
- Produces:

```ts
export function normalizeSeller(name: string): string;   // 小文字化・空白/記号除去・「で予約」等の接尾辞除去
export function classifySeller(input: { seller: string; isAirlineDirectHint?: boolean; legAirlines: string[] }, trustedOtas: string[]): SellerOffer["trust"];
export function applyTrust(offer: VerifiedOffer, trustedOtas: string[]): VerifiedOffer; // 各sellerのtrust/isAirlineDirectを確定
export function bestTrustedSeller(offer: VerifiedOffer): SellerOffer | undefined;       // trusted内の最安
```

- [ ] **Step 1: 失敗するテスト** — `test/trust.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifySeller, normalizeSeller } from "../src/core/trust";

const trusted = ["trip.com", "booking.com"];

describe("normalizeSeller", () => {
  test("「ZIPAIRで予約」→ zipair", () => expect(normalizeSeller("ZIPAIRで予約")).toBe("zipair"));
  test("Trip.com → tripcom（記号除去）", () => expect(normalizeSeller("Trip.com")).toBe("tripcom"));
});

describe("classifySeller", () => {
  test("SerpAPIのairlineフラグは無条件でairline", () => {
    expect(classifySeller({ seller: "Gotogate", isAirlineDirectHint: true, legAirlines: [] }, trusted)).toBe("airline");
  });
  test("販売元名が運航会社名と一致→airline（GFブラウザ経路）", () => {
    expect(classifySeller({ seller: "Thai AirAsia Xで予約", legAirlines: ["Thai AirAsia X"] }, trusted)).toBe("airline");
  });
  test("trusted OTAは部分一致（trip.com）", () => {
    expect(classifySeller({ seller: "Trip.com (トリップドットコム)", legAirlines: ["ZIPAIR"] }, trusted)).toBe("trusted_ota");
  });
  test("Agoda・無名OTAはreference", () => {
    expect(classifySeller({ seller: "Agoda", legAirlines: [] }, trusted)).toBe("reference");
    expect(classifySeller({ seller: "Mytrip", legAirlines: [] }, trusted)).toBe("reference");
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/trust.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — normalize: NFKC→小文字→`で予約|にて予約|book with`除去→`[^a-z0-9]`除去。airline判定: `isAirlineDirectHint===true` または 正規化名とlegAirlines正規化名の**片方向包含**（`a.includes(b)||b.includes(a)`、空文字ガード）。trusted判定: 正規化した`trusted_otas`要素を包含。`applyTrust`/`bestTrustedSeller`はmap/filter+最小値。
- [ ] **Step 4: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: 販売元の信頼分類(直販判定/OTA allowlist)"`

---

### Task 10: 経路合成エンジン

**Files:**
- Create: `src/core/combiner.ts`
- Test: `test/combiner.test.ts`

**Interfaces:**
- Consumes: `FareObservation`, `GroundLeg`, `Config`, `hoursBetween`, `addDays`, `stableId`
- Produces:

```ts
export function combine(observations: FareObservation[], cfg: Config): Itinerary[];
// 仕様:
// - 直行/単一予約: origin∈origins∪positioning かつ destination∈destinations
// - 別切り: (O→H) + (H→D)  H∈hubs、D2∈{D1, D1+1(allow_next_day時)}
//   時刻既知: min_connect_hours ≤ 接続 ≤ max_connect_hours。片方でも時刻不明: 同日ペアはrisk「時刻要確認」、翌日ペアはrisk「翌日乗継(宿泊の可能性)」
//   到着空港≠出発空港(コード不一致): 接続6h未満は除外、それ以外はrisk「空港移動あり」
// - 国内ポジショニング: O∈positioning の経路に TYO→O のアクセスを前置。
//   アクセス = ground表(あれば) と 国内線観測(TYO→O) の両方を候補化（別Itinerary）
//   国内線アクセスにも別切りと同じ接続規則。groundは接続規則なし+国際レグが12時前発ならrisk「前日移動推奨」
// - 総額 = Σ legPriceJpy×(market!=="jp" ? 1+fx_fee_rate : 1)（四捨五入） + ground費。fxFeeJpy = 上乗せ合計
// - kind: 1レグtransfers=0→direct / 1レグtransfers>0→through / 2レグ国際→self_transfer / アクセス付き→positioned
// - risks: 別切り経路は常に「自己乗継(別切り)」を含む
// - 総所要 max_total_hours 超（時刻既知分のみ計算可能な場合に適用）は除外
// - 総額昇順ソート、上位20件。id = stableId(全レグid結合)
```

- [ ] **Step 1: 失敗するテスト** — `test/combiner.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { combine } from "../src/core/combiner";
import type { FareObservation } from "../src/types";

const cfg = loadConfig({ env: {} });
const ob = (o: Partial<FareObservation>): FareObservation => ({
  id: Math.random().toString(16).slice(2, 14), source: "travelpayouts",
  origin: "TYO", destination: "BKK", departDate: "2026-08-02", transfers: 0,
  priceJpy: 20000, market: "jp", foundAt: "2026-07-18T00:00:00+09:00", ...o,
});

describe("combine", () => {
  test("直行はdirect、乗継ありはthrough", () => {
    const its = combine([ob({ priceJpy: 14000 }), ob({ transfers: 1, priceJpy: 12000 })], cfg);
    expect(its.map((i) => i.kind).sort()).toEqual(["direct", "through"]);
  });
  test("別切り: 時刻既知で接続4h未満は除外、4h以上は採用", () => {
    const leg1ok = ob({ origin: "TYO", destination: "SEL", departAt: "2026-08-02T08:00", arriveAt: "2026-08-02T10:30", priceJpy: 5000 });
    const leg2 = ob({ origin: "SEL", destination: "BKK", departAt: "2026-08-02T15:00", arriveAt: "2026-08-02T19:00", priceJpy: 6000, market: "kr" });
    const leg1late = ob({ origin: "TYO", destination: "SEL", departAt: "2026-08-02T11:30", arriveAt: "2026-08-02T13:30", priceJpy: 4000 });
    const its = combine([leg1ok, leg2, leg1late], cfg).filter((i) => i.kind === "self_transfer");
    expect(its).toHaveLength(1); // leg1late(接続1.5h)は不成立
    expect(its[0]!.risks).toContain("自己乗継(別切り)");
  });
  test("別切りの海外市場レグにはfx手数料が乗る", () => {
    const leg1 = ob({ origin: "TYO", destination: "SEL", departAt: "2026-08-02T08:00", arriveAt: "2026-08-02T10:30", priceJpy: 5000 });
    const leg2 = ob({ origin: "SEL", destination: "BKK", departAt: "2026-08-02T16:00", arriveAt: "2026-08-02T20:00", priceJpy: 10000, market: "kr" });
    const it = combine([leg1, leg2], cfg).find((i) => i.kind === "self_transfer")!;
    expect(it.totalJpy).toBe(5000 + Math.round(10000 * 1.022));
    expect(it.fxFeeJpy).toBe(220);
  });
  test("時刻不明の同日別切りは「時刻要確認」、翌日はallow_next_dayで成立", () => {
    const leg1 = ob({ origin: "TYO", destination: "TPE", priceJpy: 4000 });
    const leg2same = ob({ origin: "TPE", destination: "BKK", priceJpy: 5000, market: "tw" });
    const leg2next = ob({ origin: "TPE", destination: "BKK", departDate: "2026-08-03", priceJpy: 4500, market: "tw" });
    const its = combine([leg1, leg2same, leg2next], cfg).filter((i) => i.kind === "self_transfer");
    expect(its).toHaveLength(2);
    expect(its.find((i) => i.legs.length === 2 && (i.legs[1] as FareObservation).departDate === "2026-08-02")!.risks).toContain("時刻要確認");
    expect(its.find((i) => (i.legs[1] as FareObservation).departDate === "2026-08-03")!.risks).toContain("翌日乗継(宿泊の可能性)");
  });
  test("国内ポジショニング: OSA発国際線にground前置でpositioned", () => {
    const intl = ob({ origin: "OSA", destination: "BKK", departAt: "2026-08-02T14:00", priceJpy: 8000 });
    const its = combine([intl], cfg).filter((i) => i.kind === "positioned");
    expect(its).toHaveLength(1);
    expect(its[0]!.totalJpy).toBe(8000 + 6000); // 夜行バス
    expect(its[0]!.risks).not.toContain("前日移動推奨"); // 14時発
  });
  test("FUK発はground表に無いので国内線観測が無ければ経路化されない", () => {
    const intl = ob({ origin: "FUK", destination: "BKK", priceJpy: 7000 });
    expect(combine([intl], cfg).filter((i) => i.kind === "positioned")).toHaveLength(0);
  });
  test("FUK発+国内線観測があれば3レグ相当のpositioned成立", () => {
    const dom = ob({ origin: "TYO", destination: "FUK", departAt: "2026-08-02T07:00", arriveAt: "2026-08-02T09:00", priceJpy: 5000 });
    const intl = ob({ origin: "FUK", destination: "BKK", departAt: "2026-08-02T14:00", arriveAt: "2026-08-02T18:00", priceJpy: 7000 });
    const its = combine([dom, intl], cfg).filter((i) => i.kind === "positioned");
    expect(its).toHaveLength(1);
    expect(its[0]!.totalJpy).toBe(12000);
  });
  test("総額昇順・上位20件", () => {
    const many = Array.from({ length: 30 }, (_, i) => ob({ priceJpy: 10000 + i * 100, id: `d${i}` }));
    const its = combine(many, cfg);
    expect(its).toHaveLength(20);
    expect(its[0]!.totalJpy).toBeLessThanOrEqual(its[19]!.totalJpy);
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/combiner.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装**（核心アルゴリズム。以下の構造で書く）:

```ts
// src/core/combiner.ts の骨格（完全版をこの構造で実装する）
export function combine(observations: FareObservation[], cfg: Config): Itinerary[] {
  const intlOrigins = [...cfg.origins, ...cfg.positioning];
  const byRoute = groupBy(observations, (o) => `${o.origin}|${o.destination}`);
  const out: Itinerary[] = [];

  // ① 直行/単一予約 + ② 別切り（各国際起点Oごとに国際部分を組む）
  for (const O of intlOrigins) {
    const intlParts: { legs: FareObservation[]; risks: string[] }[] = [];
    for (const D of cfg.destinations) {
      for (const obs of byRoute.get(`${O}|${D}`) ?? []) intlParts.push({ legs: [obs], risks: [] });
      for (const H of cfg.hubs) {
        for (const l1 of byRoute.get(`${O}|${H}`) ?? []) {
          for (const l2 of byRoute.get(`${H}|${D}`) ?? []) {
            const pair = pairLegs(l1, l2, cfg.combine); // null | { risks: string[] }
            if (pair) intlParts.push({ legs: [l1, l2], risks: ["自己乗継(別切り)", ...pair.risks] });
          }
        }
      }
    }
    // ③ 起点がpositioningならアクセスを前置、TYOならそのまま
    for (const part of intlParts) {
      if (cfg.origins.includes(O)) { out.push(buildItinerary(part.legs, part.risks, cfg)); continue; }
      const g = cfg.ground.find((g) => g.to === O);
      if (g) out.push(buildItinerary(part.legs, part.risks, cfg, groundLeg(g)));
      for (const dom of byRoute.get(`TYO|${O}`) ?? []) {
        const pair = pairLegs(dom, part.legs[0]!, cfg.combine);
        if (pair) out.push(buildItinerary([dom, ...part.legs], [...part.risks, "自己乗継(別切り)", ...pair.risks], cfg));
      }
    }
  }
  return dedupeById(out).filter(withinTotalHours(cfg)).sort((a, b) => a.totalJpy - b.totalJpy).slice(0, 20);
}
```

`pairLegs(a, b, rules)`: 日付関係を先に判定（`b.departDate === a.departDate` or `=== addDays(a.departDate,1)` かつ allow_next_day、それ以外null）。両時刻あり→`hoursBetween(a.arriveAt, b.departAt)` を `[min_connect_hours, max_connect_hours]` で判定+空港コード不一致（`a.destination !== b.origin` は都市キーが同じでも空港が違う場合を含む。observationの都市/空港が同一文字列比較で不一致かつ接続<6h→null、≥6h→risk「空港移動あり」）。時刻欠け→同日: risk「時刻要確認」/ 翌日: risk「翌日乗継(宿泊の可能性)」。`buildItinerary`: kind判定・fx計算（`Math.round(p*(1+rate))-p`加算）・ground前置時は国際レグ`departAt`が`T12:00`未満（時刻既知時）でrisk「前日移動推奨」・id=stableId(legs全id)。
- [ ] **Step 4: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: 経路合成エンジン(直行/別切り/国内ポジショニング)"`

---

### Task 11: ティア判定と再通知抑制

**Files:**
- Create: `src/core/dedupe.ts`
- Test: `test/dedupe.test.ts`

**Interfaces:**
- Consumes: `Itinerary`, `Config`, `Store.readNotified()`
- Produces:

```ts
export function assignTier(it: Itinerary, cfg: Config): Tier | undefined;
// verified: ≤flash_max→"flash", ≤notify_max→"deal"
// unverified/price_confirmed/partial: ≤notify_max→"candidate"
// 上記以外→undefined（通知なし・deals.jsonには残る）
export function dealKey(it: Itinerary): string;
// `${区間列(origin-destination...)}|${departDate}|${便名列(空可)}|${sellerClass}` sellerClass = verified? "trusted" : "none"
export function shouldNotify(it: Itinerary, key: string, last: { priceJpy: number; at: string; tier: string } | undefined, now: Date): boolean;
// (a) lastなし → true
// (b) 値下がり max(500, last.priceJpy*0.03) 以上 → true
// (c) last.tier==="candidate" かつ 今回 flash/deal（昇格）→ true
// それ以外 false
export function expireDeals(deals: Itinerary[], todayJstStr: string): Itinerary[]; // 出発日を過ぎたものを除外
```

- [ ] **Step 1: 失敗するテスト** — `test/dedupe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { assignTier, dealKey, expireDeals, shouldNotify } from "../src/core/dedupe";
import type { Itinerary } from "../src/types";

const cfg = loadConfig({ env: {} });
const it = (over: Partial<Itinerary>): Itinerary => ({
  id: "i1", kind: "direct", legs: [], totalJpy: 14000, fxFeeJpy: 0, risks: [],
  verification: "verified", ...over,
});
const now = new Date("2026-07-18T00:00:00Z");

describe("assignTier", () => {
  test("verified 9,800→flash / 14,000→deal / 15,001→なし", () => {
    expect(assignTier(it({ totalJpy: 9800 }), cfg)).toBe("flash");
    expect(assignTier(it({ totalJpy: 14000 }), cfg)).toBe("deal");
    expect(assignTier(it({ totalJpy: 15001 }), cfg)).toBeUndefined();
  });
  test("price_confirmedはflash圏でもcandidate", () => {
    expect(assignTier(it({ totalJpy: 9800, verification: "price_confirmed" }), cfg)).toBe("candidate");
  });
});

describe("shouldNotify", () => {
  const k = "TYO-BKK|2026-08-02||trusted";
  test("初出→true", () => expect(shouldNotify(it({}), k, undefined, now)).toBe(true));
  test("小幅値下がり(300円)→false、3%以上→true", () => {
    const last = { priceJpy: 14000, at: "2026-07-17T00:00:00Z", tier: "deal" };
    expect(shouldNotify(it({ totalJpy: 13700 }), k, last, now)).toBe(false);
    expect(shouldNotify(it({ totalJpy: 13400 }), k, last, now)).toBe(true); // -600 ≥ max(500, 420)
  });
  test("candidate→verified昇格はtrue", () => {
    const last = { priceJpy: 14000, at: "2026-07-17T00:00:00Z", tier: "candidate" };
    expect(shouldNotify(it({ totalJpy: 14000, tier: "deal" } as Itinerary), k, last, now)).toBe(true);
  });
});

test("expireDealsは出発日超過を落とす", () => {
  const a = it({ legs: [{ id: "l", source: "fli", origin: "TYO", destination: "BKK", departDate: "2026-07-17", transfers: 0, priceJpy: 1, market: "jp", foundAt: "x" }] });
  expect(expireDeals([a], "2026-07-18")).toEqual([]);
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/dedupe.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — 仕様どおりの純関数。`dealKey` の区間列はflightレグのみ（groundは除外）、出発日は最初のflightレグの`departDate`。`expireDeals` は最初のflightレグ基準。
- [ ] **Step 4: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: 通知ティアと再通知抑制ルール"`

---

### Task 12: Discord通知

**Files:**
- Create: `src/notify/discord.ts`
- Test: `test/discord.test.ts`

**Interfaces:**
- Consumes: `Itinerary`, `SaleNews`, `bestTrustedSeller`
- Produces:

```ts
export function buildDealEmbed(it: Itinerary, opts?: { seller?: SellerOffer; gfUrl?: string }): object; // Discord embed 1個
export function buildNewsEmbed(n: SaleNews): object;
export function buildHealthEmbed(source: string, h: SourceHealth): object;
export class DiscordNotifier {
  constructor(webhookUrl: string, deps?: { fetchImpl?: typeof fetch });
  send(embeds: object[]): Promise<void>; // 最大10embed/回で分割。失敗3回リトライ後throw
}
```

- [ ] **Step 1: 失敗するテスト** — `test/discord.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DiscordNotifier, buildDealEmbed } from "../src/notify/discord";
import type { Itinerary } from "../src/types";

const it: Itinerary = {
  id: "i1", kind: "self_transfer", totalJpy: 12220, fxFeeJpy: 220,
  risks: ["自己乗継(別切り)", "時刻要確認"], verification: "verified", tier: "deal",
  legs: [
    { id: "l1", source: "fli", origin: "NRT", destination: "ICN", departDate: "2026-08-02", departAt: "2026-08-02T08:00", airline: "Jin Air", flightNumber: "LJ 202", transfers: 0, priceJpy: 5000, market: "jp", foundAt: "2026-07-18T00:00:00Z" },
    { id: "l2", source: "fli", origin: "ICN", destination: "BKK", departDate: "2026-08-02", departAt: "2026-08-02T16:00", airline: "t'way", flightNumber: "TW 101", transfers: 0, priceJpy: 7000, market: "kr", foundAt: "2026-07-18T00:00:00Z" },
  ],
};

describe("buildDealEmbed", () => {
  test("タイトルに🔥と総額、本文に経路・リスク・検証状態", () => {
    const e = buildDealEmbed(it) as { title: string; description: string };
    expect(e.title).toContain("🔥");
    expect(e.title).toContain("12,220");
    expect(e.description).toContain("NRT → ICN → BKK");
    expect(e.description).toContain("自己乗継");
    expect(e.description).toContain("verified");
  });
});

describe("DiscordNotifier", () => {
  test("webhookへPOSTし、11embedは2回に分割", async () => {
    const calls: string[] = [];
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.body)); return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const n = new DiscordNotifier("https://discord.example/wh", { fetchImpl: f });
    await n.send(Array.from({ length: 11 }, (_, i) => ({ title: `e${i}` })));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!).embeds).toHaveLength(10);
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/discord.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — embed: `title: "${絵文字} ¥12,220 東京→バンコク 8/2発"`（絵文字: flash💥/deal🔥/candidate⚠️）、description に経路行（`origin → ... → destination`）、レグ内訳（`便名 ¥金額 (販売元/鮮度)`）、fx手数料行、risks行（各行`⚠`前置）、検証状態、`seller`があれば`予約: {seller.seller} ¥{price}`+URL、`gfUrl`行。色: flash=0xff2d55, deal=0xff9500, candidate=0x8e8e93, news=0x0a84ff。`send`: `POST {url}?wait=true` JSON `{embeds}`、10個ずつchunk、リトライはfetchJsonを流用（204/200を成功扱い、fetchJsonはJSONでない204を許容するよう`fetchText`利用）。
- [ ] **Step 4: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: Discord embed通知(ティア別・分割送信)"`

---

### Task 13: スケジューラ・検証パイプライン・watch統合

**Files:**
- Create: `src/core/windows.ts`, `src/core/verify.ts`, `src/core/pipeline.ts`, `src/sources/index.ts`
- Test: `test/windows.test.ts`, `test/pipeline.test.ts`

**Interfaces:**
- Consumes: これまでの全モジュール
- Produces:

```ts
// src/core/windows.ts
export type Job =
  | { id: `window:${string}`; kind: "window"; window: WindowConf; caps: [] }
  | { id: `rss:${string}`; kind: "rss"; feed: FeedConf; caps: [] }
  | { id: "deep-sweep"; kind: "deep-sweep"; everyMinutes: number; caps: ["browser"] }
  | { id: "verify-queue"; kind: "verify-queue"; everyMinutes: 30; caps: ["browser"] };
export function allJobs(cfg: Config): Job[];
export function dueJobs(jobs: Job[], lastRuns: Record<string, string>, env: RunnerEnv): Job[];
// due条件: lastRunなし or (now - lastRun) ≥ every_minutes。capsを満たさないランナーでは対象外

// src/core/verify.ts
export type VerifyDeps = { sources: FareSource[]; env: RunnerEnv; cfg: Config };
export function verifyItinerary(it: Itinerary, deps: VerifyDeps): Promise<Itinerary>;
// 手順: flightレグごとに (1) fli.verify で価格確認（±20%以内の同便/同区間最安を採用し priceJpy更新、消えたらverification="unverified"のまま返す）
//        (2) 販売元ソース（gf-browser or serpapi、availableな方。両方ダメならスキップ）で verify → applyTrust → bestTrustedSeller
// 全レグsellers確認済→"verified" / 一部→"partial" / fli確認のみ→"price_confirmed"

// src/core/pipeline.ts
export type RunResult = { jobsRun: string[]; observations: number; notified: number; errors: string[] };
export function runWatchOnce(deps: {
  cfg: Config; store: Store; env: RunnerEnv;
  sources: FareSource[]; rss: RssSignal; notifier?: DiscordNotifier;
  dryRun?: boolean;
}): Promise<RunResult>;
// 1. dueJobs算出 2. windowジョブ: 対象ペア生成→sweep可能ソースで掃引→appendFares
// 3. rssジョブ: poll→ℹ️通知→state更新（マッチ時はimmediate/near窓を強制due化）
// 4. readRecentFares(48h)→combine→assignTier対象(≤notify_max×watch_margin)を検証キューへ
// 5. verify-queue処理(能力があれば即時、なければstate.verifyQueueに積むだけ)→ティア再判定
// 6. shouldNotifyで絞ってDiscord送信→appendNotified 7. deals.json書き込み(expire済) 8. lastRuns/health更新
// dryRun: 通知send/state永続化をスキップし、送信予定embedをRunResultに含めず件数のみ返す

// src/sources/index.ts
export function buildSources(cfg: Config, store: Store, env: RunnerEnv): FareSource[];
// [gf-browser(ローカルのみ・Task15で差し込み。それまでは含めない), fli, travelpayouts, serpapi] のavailableなもの
```

- [ ] **Step 1: 失敗するテスト** — `test/windows.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { allJobs, dueJobs } from "../src/core/windows";

const cfg = loadConfig({ env: {} });
const envCI = { isCI: true, hasBrowser: false, now: new Date("2026-07-18T10:00:00Z") };
const envLocal = { ...envCI, isCI: false, hasBrowser: true };

describe("windows scheduler", () => {
  test("allJobsはwindow2+rss2+deep-sweep+verify-queueを生成", () => {
    expect(allJobs(cfg).map((j) => j.id).sort()).toEqual(
      ["deep-sweep", "rss:sky-budget", "rss:traicy-sale", "verify-queue", "window:immediate", "window:near"].sort(),
    );
  });
  test("lastRunが新しい窓はdueにならない", () => {
    const last = { "window:immediate": "2026-07-18T09:45:00Z", "window:near": "2026-07-18T08:00:00Z" };
    const ids = dueJobs(allJobs(cfg), last, envCI).map((j) => j.id);
    expect(ids).not.toContain("window:immediate"); // 15分前 < 30分
    expect(ids).toContain("window:near");          // 120分前 ≥ 60分
  });
  test("browser能力ジョブはCIで対象外・ローカルで対象", () => {
    expect(dueJobs(allJobs(cfg), {}, envCI).map((j) => j.id)).not.toContain("deep-sweep");
    expect(dueJobs(allJobs(cfg), {}, envLocal).map((j) => j.id)).toContain("deep-sweep");
  });
});
```

`test/pipeline.test.ts`（モックソースで貫通）:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { runWatchOnce } from "../src/core/pipeline";
import { RssSignal } from "../src/signals/rss";
import { Store } from "../src/state/store";
import type { FareObservation, VerifiedOffer } from "../src/types";

const cfg = loadConfig({ env: { DISCORD_WEBHOOK_URL: "https://discord.example/wh" } });
const now = new Date("2026-07-18T10:00:00Z");
const cheapObs: FareObservation = {
  id: "cheap1", source: "travelpayouts", origin: "TYO", destination: "BKK",
  departDate: "2026-08-02", transfers: 0, priceJpy: 13000, market: "jp",
  foundAt: now.toISOString(),
};
const mockSweep = { name: "mock-sweep", available: () => true, sweep: async () => [cheapObs] };
const mockVerify = {
  name: "mock-verify", available: () => true,
  verify: async (): Promise<VerifiedOffer[]> => [{
    ...cheapObs, source: "serpapi",
    sellers: [{ seller: "ZIPAIR", isAirlineDirect: true, trust: "airline", priceJpy: 13000 }],
  }],
};
const rssEmpty = new RssSignal(cfg, { fetchImpl: (async () => new Response("<rss><channel></channel></rss>")) as unknown as typeof fetch });

describe("runWatchOnce", () => {
  test("掃引→合成→検証→通知が貫通し、stateが更新される", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
    const sent: string[] = [];
    const notifier = { send: async (embeds: object[]) => { sent.push(JSON.stringify(embeds)); } };
    const r = await runWatchOnce({
      cfg, store, env: { isCI: true, hasBrowser: false, now },
      sources: [mockSweep, mockVerify] as never, rss: rssEmpty, notifier: notifier as never,
    });
    expect(r.errors).toEqual([]);
    expect(r.observations).toBeGreaterThan(0);
    expect(r.notified).toBe(1);
    expect(sent[0]).toContain("13,000");
    expect(store.readDeals().length).toBeGreaterThan(0);
    expect(Object.keys(store.readState().lastRuns)).toContain("window:immediate");
    // 再実行: 窓は期限前・同dealは再通知されない
    const r2 = await runWatchOnce({ cfg, store, env: { isCI: true, hasBrowser: false, now: new Date(now.getTime() + 60e3) }, sources: [mockSweep, mockVerify] as never, rss: rssEmpty, notifier: notifier as never });
    expect(r2.notified).toBe(0);
  });
  test("dryRunは通知もstate書き込みもしない", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
    const r = await runWatchOnce({ cfg, store, env: { isCI: true, hasBrowser: false, now }, sources: [mockSweep, mockVerify] as never, rss: rssEmpty, dryRun: true });
    expect(r.notified).toBe(1); // 「通知され得た」件数は返す
    expect(store.readDeals()).toEqual([]);
    expect(store.readState().lastRuns).toEqual({});
  });
  test("ソース例外はerrorsに載り継続する", async () => {
    const boom = { name: "boom", available: () => true, sweep: async () => { throw new Error("api down"); } };
    const store = new Store(mkdtempSync(join(tmpdir(), "tfw-")));
    const r = await runWatchOnce({ cfg, store, env: { isCI: true, hasBrowser: false, now }, sources: [boom, mockSweep, mockVerify] as never, rss: rssEmpty, dryRun: true });
    expect(r.errors.some((e) => e.includes("boom"))).toBe(true);
    expect(r.observations).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/windows.test.ts test/pipeline.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — windows: 上記仕様の純関数。pipeline: 手順コメントどおり直列実装。ペア生成: 窓ごとに `origins∪positioning → destinations`、`origins∪positioning → hubs`、`hubs → destinations`、`TYO → positioning`（国内線）。market はレグorigin側の国（`const MARKET: Record<string,string> = { TYO:"jp",OSA:"jp",NGO:"jp",FUK:"jp",OKA:"jp",SEL:"kr",TPE:"tw",KUL:"my",SGN:"vn",SIN:"sg",HKG:"hk",MNL:"ph" }`、未知は"jp"）。検証は `verifyItinerary` を安い順に最大5経路/回。health更新: ソースごとに成功/失敗を`SourceHealth`へ、`consecutiveFailures===6`のとき1回だけhealth embed送信（`lastErrorAt`日付で1日1回制御）。verify-queueジョブ: `state.verifyQueue` のidを `deals.json` から引いて再検証（能力がなければ何もしない）。
- [ ] **Step 4: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: 窓スケジューラと検証パイプラインでwatch貫通"`

---

### Task 14: CLI

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: 全モジュール
- Produces: `tfw` コマンド群（spec §6.11の表どおり: watch/sweep/verify/deals/history/news/quota/notify-test/config/setup-local）。全サブコマンド共通flag: `--json`, `--config <path>`, `--dry-run`。

- [ ] **Step 1: 失敗するテスト** — `test/cli.test.ts`（サブプロセスでE2E。外部APIに触れないコマンドのみ）:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    env: { ...process.env, TFW_DATA_DIR: mkdtempSync(join(tmpdir(), "tfw-")), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exitCode };
}

describe("tfw CLI", () => {
  test("config --json は秘密をマスクして出力", async () => {
    const r = await run(["config", "--json"], { TRAVELPAYOUTS_TOKEN: "tp-secret" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("tp-secret");
    expect(JSON.parse(r.stdout).thresholds.notify_max).toBe(15000);
  });
  test("deals --json は空配列で正常終了", async () => {
    const r = await run(["deals", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ deals: [] });
  });
  test("notify-test はwebhook未設定なら終了コード1とエラーメッセージ", async () => {
    const r = await run(["notify-test"], { DISCORD_WEBHOOK_URL: "" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("DISCORD_WEBHOOK_URL");
  });
  test("quota --json はキー未設定を明示", async () => {
    const r = await run(["quota", "--json"], { SERPAPI_API_KEY: "" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).enabled).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/cli.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — `#!/usr/bin/env bun` + citty `defineCommand`/`runMain`。共通セットアップ関数が `loadConfig`（`--config`）、`Store`（`TFW_DATA_DIR` env優先、テスト用）、`RunnerEnv`（`isCI: !!process.env.CI`, `hasBrowser: !isCI && browser.enabled!==false`）を構築。各コマンドはcoreを呼ぶ薄い皮。人間向け出力は `console.table`/整形文字列、`--json`は `JSON.stringify(結果)` のみをstdoutへ。`watch` は `runWatchOnce` 呼び出し（`--once`必須扱い、未指定時も1回で終了しヒントを表示）。`history` は `readRecentFares(24*45)` を区間でフィルタし日毎最安を集計。`verify` は fli(+`--sellers`時はserpapi/gf-browser)を直接呼ぶ。`setup-local` はTask 16で実装するため、ここでは「Task 16で有効化」とだけ出力して終了コード1（プレースホルダ実装を作らない）。エラーハンドリング: 例外はメッセージをstderr・終了コード1、`RunResult.errors`非空は2。
- [ ] **Step 4: パス確認とコミット** — `bun test` 全pass → `git commit -am "feat: tfw CLI(全コマンド--json対応)"`

---

### Task 15: Google Flightsブラウザアダプタ（主砲）

**Files:**
- Create: `scripts/record-gf-fixture.ts`, `src/sources/gf-browser/parse.ts`, `src/sources/gf-browser/index.ts`
- Modify: `src/sources/index.ts`（gf-browser登録）, `src/cli.ts`（verify --sellersのローカル経路）
- Test: `test/gf-parse.test.ts`, `test/fixtures/gf/`（採取スナップショット）

**Interfaces:**
- Produces:

```ts
// parse.ts（純関数・fixtureテスト対象）
export type GridCell = { date: string; priceJpy: number };
export function parseGridAria(labels: string[], year: number): GridCell[];
// 日付グリッドセルのaria-label文字列（例「8月2日 土曜日 ¥14,980」）→ GridCell。価格なしセルは除外
export function parseResultRows(rows: RowRaw[]): Omit<FareObservation, "id"|"source"|"market"|"foundAt">[];
export type RowRaw = { ariaLabel: string; priceText: string; departDate: string };
// aria-label例「8:00 発 成田国際空港、14:10 着 ドンムアン空港。所要時間6時間10分。Thai AirAsia X。¥14,980」
export function parseBookingRows(rows: { sellerText: string; priceText: string }[]): { seller: string; priceJpy: number }[];
export function parsePriceJpy(text: string): number | undefined; // "¥14,980"→14980

// index.ts
export class GfBrowserSource implements FareSource {
  name = "gf-browser";
  constructor(cfg: Config, deps?: { pw?: unknown });   // playwright遅延import
  available(env: RunnerEnv): boolean;                   // !isCI && hasBrowser
  sweep(pairs: OdPair[], range: DateRange): Promise<FareObservation[]>;   // 日付グリッド
  verify(od: OdPair, date: string): Promise<VerifiedOffer[]>;             // 結果+予約オプション
}
```

- [ ] **Step 1: Playwrightを導入し採取スクリプトを書く**

```bash
bun add playwright
bunx playwright install chrome
```

`scripts/record-gf-fixture.ts`（実行するとNRT→BKKを開き、①検索結果DOM ②日付グリッドDOM ③先頭便の予約オプションDOM を `test/fixtures/gf/` にHTML+主要aria-label JSONで保存する）:

```ts
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "test/fixtures/gf";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ locale: "ja-JP" });
const date = process.argv[2] ?? "2026-08-20";
await page.goto(`https://www.google.com/travel/flights?hl=ja&gl=jp&curr=JPY&q=${encodeURIComponent(`成田発 バンコク行き ${date} 片道`)}`);
await page.waitForLoadState("networkidle");
await Bun.write(`${OUT}/results.html`, await page.content());
// 結果行のaria-labelを収集（GFの結果はrole=listitem内のaria-labelに全情報が入る）
const rowLabels = await page.locator('ul li[role="listitem"], ul li').evaluateAll((els) =>
  els.map((e) => (e.querySelector('[aria-label*="¥"]') as HTMLElement | null)?.ariaLabel ?? e.ariaLabel ?? "").filter((s) => s.includes("¥")));
await Bun.write(`${OUT}/result-rows.json`, JSON.stringify(rowLabels, null, 2));
// 日付グリッド: 「日付」グリッドボタン→セルaria-label収集
await page.getByRole("button", { name: /日付/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
const gridLabels = await page.locator('[role="gridcell"], [aria-label*="¥"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).ariaLabel ?? "").filter((s) => /月.*¥/.test(s)));
await Bun.write(`${OUT}/grid-labels.json`, JSON.stringify(gridLabels, null, 2));
await Bun.write(`${OUT}/grid.html`, await page.content());
await page.keyboard.press("Escape");
// 予約オプション: 先頭便クリック→パネルの販売元行
await page.locator('ul li').filter({ hasText: "¥" }).first().click();
await page.waitForTimeout(4000);
await Bun.write(`${OUT}/booking.html`, await page.content());
const bookingRows = await page.locator('[aria-label*="予約"], td, div').evaluateAll((els) =>
  els.map((e) => (e as HTMLElement).innerText ?? "").filter((t) => t.includes("¥") && t.length < 200));
await Bun.write(`${OUT}/booking-rows.json`, JSON.stringify(bookingRows, null, 2));
await browser.close();
console.log("saved fixtures to", OUT);
```

Run: `bun run scripts/record-gf-fixture.ts` （headfulで挙動確認しつつ採取。**採取したJSON/HTMLを目視し、上記locatorが実DOMとずれていたらこのスクリプト自体をまず直して再採取する。** `results/grid/booking` の3点が揃うまで繰り返す。fixtures はコミットする——ただし個人情報は含まれないことを確認）

- [ ] **Step 2: 失敗するテスト** — `test/gf-parse.test.ts`（**採取したfixtureの実文字列**を入力に使う。以下は形の例で、実データの値でexpectを書き直す）:

```ts
import { describe, expect, test } from "bun:test";
import { parseGridAria, parsePriceJpy, parseResultRows } from "../src/sources/gf-browser/parse";
import gridLabels from "./fixtures/gf/grid-labels.json";
import rowLabels from "./fixtures/gf/result-rows.json";

describe("parsePriceJpy", () => {
  test("¥14,980→14980 / ¥1.5万のような表記はundefined", () => {
    expect(parsePriceJpy("¥14,980")).toBe(14980);
    expect(parsePriceJpy("残席わずか")).toBeUndefined();
  });
});

describe("実fixtureパース", () => {
  test("グリッドから日付+価格が10件以上取れる", () => {
    const cells = parseGridAria(gridLabels as string[], 2026);
    expect(cells.length).toBeGreaterThan(10);
    for (const c of cells) {
      expect(c.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(c.priceJpy).toBeGreaterThan(3000);
    }
  });
  test("結果行から出発時刻・航空会社・価格が取れる", () => {
    const rows = parseResultRows((rowLabels as string[]).map((ariaLabel) => ({ ariaLabel, priceText: "", departDate: "2026-08-20" })));
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]!.priceJpy).toBeGreaterThan(3000);
    expect(rows[0]!.airline).toBeTruthy();
  });
});
```

- [ ] **Step 3: 失敗確認** — Run: `bun test test/gf-parse.test.ts` / Expected: FAIL
- [ ] **Step 4: parse.ts実装** — 正規表現ベースの純関数: 価格 `/[¥￥]\s*([\d,]+)/`、グリッド `「(\d{1,2})月(\d{1,2})日」`+価格（年は引数、12月→1月跨ぎは月が小さくなったら翌年）、結果行 `「(\d{1,2}):(\d{2})」発着×2 + 航空会社名（「。」区切りセグメント） + 価格 + 「直行|乗り継ぎN回」`。fixtureの実文字列に合わせて調整し、**パース不能行はスキップして絶対にthrowしない**。
- [ ] **Step 5: GfBrowserSource実装** — sweep: ペアごとに `?q=` URLで開き→日付グリッドを開き→`parseGridAria`（グリッドは価格のみで便情報が無いので `airline/flightNumber/departAt` 空・`transfers: -1`は不可のため `transfers: 0`とし **risk判定に使わないunverifiedグリッド観測**として `expiresAt=+6h` を設定）。verify: 対象日の結果行→`parseResultRows`→最安行クリック→予約オプション行→`parseBookingRows`→sellersへ（`classifySeller`はcombiner側でなくここで `applyTrust` を呼ばず素の `{seller, priceJpy}` を `SellerOffer`（trust未確定は"reference"仮置き）にし、verify.tsが`applyTrust`で確定）。レート制御: 操作間 `min_interval_sec + rand(jitter_sec)` 秒 `Bun.sleep`。ページ0件/CAPTCHA文言検知でthrow（ヘルスへ）。ブラウザは1 sweep/verify呼び出し内で1インスタンス使い回し、終了時close。
- [ ] **Step 6: 手動スモーク** — Run: `bun run src/cli.ts verify NRT BKK <30日後> --sellers` （ローカル）
Expected: 実価格+販売元リスト（ZIPAIR直販等）がJSONで出る。実行ログの販売元名を `tfw.config.toml` のtrusted_otasと突き合わせて表記ゆれがあればnormalizeSellerを補強
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: Google Flightsブラウザアダプタ(日付グリッド掃引+販売元検証)"`

---

### Task 16: ローカル定期実行（launchd）と同期スクリプト

**Files:**
- Create: `scripts/watch-and-sync.sh`
- Modify: `src/cli.ts`（`setup-local` 本実装）
- Test: `test/setup-local.test.ts`

**Interfaces:**
- Produces: `tfw setup-local [--uninstall] [--dry-run]` が launchd plist を生成・登録。`watch-and-sync.sh` が pull→watch→commit&push を行う。

- [ ] **Step 1: 失敗するテスト** — `test/setup-local.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { renderPlist } from "../src/cli";

describe("renderPlist", () => {
  test("bun絶対パス・リポジトリパス・1800秒間隔を含む", () => {
    const p = renderPlist({ bunPath: "/opt/bun", repoDir: "/repo", logDir: "/logs" });
    expect(p).toContain("<string>/repo/scripts/watch-and-sync.sh</string>");
    expect(p).toContain("<integer>1800</integer>");
    expect(p).toContain("tech.incerto.tfw");
    expect(p).toContain("/logs/tfw.log");
  });
});
```

- [ ] **Step 2: 失敗確認** — Run: `bun test test/setup-local.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — `scripts/watch-and-sync.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/mise/installs/bun/latest/bin:/opt/homebrew/bin:$PATH"
[ -f .env ] && set -a && source .env && set +a
git pull --rebase --autostash --quiet || true
bun run src/cli.ts watch --once --json >> "${TFW_LOG_DIR:-$HOME/Library/Logs/tfw}/watch.jsonl" 2>&1 || true
if ! git diff --quiet -- data/; then
  git add data/
  git commit --quiet -m "data: watch $(date +%Y-%m-%dT%H:%M)"
  git push --quiet || { git pull --rebase --quiet && git push --quiet; }
fi
```

`renderPlist` はエクスポートされた純関数（Label `tech.incerto.tfw` / ProgramArguments=[bash, <repo>/scripts/watch-and-sync.sh] / StartInterval 1800 / RunAtLoad true / StandardOut/ErrorPath `<logDir>/tfw.log`）。`setup-local` コマンド: `process.execPath`でbunパス、`import.meta.dir`起点でrepoDir解決、`~/Library/LaunchAgents/tech.incerto.tfw.plist` へ書き `launchctl bootstrap gui/$(id -u) <plist>`（`--uninstall`は`bootout`+plist削除、`--dry-run`はplist内容を表示のみ）。`mkdir -p ~/Library/Logs/tfw`。
- [ ] **Step 4: パス確認と手動確認** — `bun test` 全pass → `bun run src/cli.ts setup-local --dry-run` でplist出力を目視 → `chmod +x scripts/watch-and-sync.sh`
- [ ] **Step 5: Commit** — `git commit -am "feat: launchd定期実行とgit同期スクリプト"`

---

### Task 17: GitHub Actionsワークフローとドキュメント・スキル

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/watch.yml`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `skills/thai-fare-watch/SKILL.md`

**Interfaces:**
- Consumes: `tfw watch --once`（終了コード0/2を成功扱い）

- [ ] **Step 1: ci.yml**:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx biome ci .
      - run: bun test
```

- [ ] **Step 2: watch.yml**:

```yaml
name: watch
on:
  schedule:
    - cron: "7,37 * * * *"
  workflow_dispatch:
concurrency:
  group: watch
  cancel-in-progress: false
permissions:
  contents: write
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: astral-sh/setup-uv@v6            # fli用
      - run: bun install --frozen-lockfile
      - name: watch
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          TRAVELPAYOUTS_TOKEN: ${{ secrets.TRAVELPAYOUTS_TOKEN }}
          SERPAPI_API_KEY: ${{ secrets.SERPAPI_API_KEY }}
        run: |
          bun run src/cli.ts watch --once --json || [ $? -eq 2 ]
      - name: commit data
        run: |
          git config user.name "tfw-bot"
          git config user.email "actions@users.noreply.github.com"
          if ! git diff --quiet -- data/; then
            git add data/
            git commit -m "data: watch $(date -u +%Y-%m-%dT%H:%MZ)"
            git pull --rebase && git push
          fi
```

- [ ] **Step 3: ドキュメント3点+スキルを書く** — 内容要件:
  - `README.md`: 目的1段落 / アーキテクチャ図（spec §5を簡約）/ セットアップ（`bun install`→`.env`→`bunx playwright install chrome`→`tfw setup-local`→APIキー2種の取得URL）/ CLI表 / データファイル表 / ⚠️自己乗継リスクの免責。
  - `AGENTS.md`: リポジトリ規約（bun/bun:test/Biome/conventional commits）、`bun run tfw <cmd> --json` の使い方、`data/`ファイルの意味、**やってはいけないこと**（秘密のコミット、`data/`の手編集、ライブAPIを叩くテスト追加）。
  - `CLAUDE.md`: `AGENTS.md を参照。` の1行+スキル場所の案内。
  - `skills/thai-fare-watch/SKILL.md`: frontmatter `name: thai-fare-watch` / `description: 東京→タイ格安航空券監視botの操作。今の最安確認・特定日の即時検証・しきい値変更・通知履歴の確認を行うときに使う`。本文: 前提（このrepoでコマンド実行）、コマンドレシピ表（「今の最安は?」→`bun run tfw deals --json`、「8/2を検証して」→`bun run tfw verify NRT BKK 2026-08-02 --sellers --json`、「しきい値変更」→`tfw.config.toml`のthresholds編集+commit、「監視状況は?」→`bun run tfw config --json`+`data/health.json`）、`--json`出力の主要フィールド説明、終了コード解釈。導入: `ln -s <repo>/skills/thai-fare-watch ~/.claude/skills/thai-fare-watch`。
- [ ] **Step 4: 全体確認** — Run: `bun test && bunx biome ci .` / Expected: 全pass
- [ ] **Step 5: Commit&Push** — `git add -A && git commit -m "feat: CI/監視ワークフローとドキュメント・agentスキル" && git push`

---

### Task 18: 実運用開始（本番検証）

**Files:** なし（運用手順）

- [ ] **Step 1: 通知経路の実確認** — Run: `bun run src/cli.ts notify-test`
Expected: Discordチャンネルにテストembedが届く（ユーザー目視確認を依頼）
- [ ] **Step 2: ローカル1周** — Run: `bash scripts/watch-and-sync.sh` → `git log --oneline -1` が `data: watch ...` になり、`bun run src/cli.ts deals --json` に観測が入る（fli+GFブラウザ経路。TPキー未設定でも動くことを確認）
- [ ] **Step 3: Actions1周** — `gh workflow run watch && sleep 90 && gh run list --workflow=watch --limit 1`
Expected: success。ログでfliのCB/縮退が想定どおりか確認（DC IPブロック時はTravelpayouts無しだと観測0もあり得る——その場合はヘルスにその旨が残ることを確認し、ユーザーへтpキー登録を再案内）
- [ ] **Step 4: launchd登録** — `bun run src/cli.ts setup-local` → `launchctl list | grep tfw`
Expected: 登録済み。30分後に自動実行され `data/` に新コミットが積まれる
- [ ] **Step 5: 初期チューニング記録** — 24時間後に `tfw history TYO BKK` と `data/health.json` を確認し、観測密度・ブロック率をREADMEの「運用メモ」節に追記してコミット

---

## Self-Review（実施済み）

1. **Spec coverage:** §6.1→T3 / §6.2→T5,6,7,15 / §6.3→T8 / §6.4-6.5→T10 / §6.6→T9 / §6.7→T13 / §6.8→T13 / §6.9→T11 / §6.10→T12 / §6.11→T14,16 / §6.12→T4 / §6.14→T16,17 / §6.15→T17 / §9→T4,6,13 / §12→T1,17,18。§6.13(web)は別プラン（本文冒頭に明記）。
2. **Placeholder scan:** fli CLI引数とGF DOMは「実物から採取して確定する手順」を具体的コマンド付きで定義（外部システムの現物依存であり、推測で書き固定する方が危険）。それ以外のTBDなし。T14のsetup-localは「未実装を明示して終了コード1」でありプレースホルダ実装ではない（T16で本実装）。
3. **Type consistency:** 全タスクが `src/types.ts`（T2）と各タスクのProduces宣言を参照。`FareSource`/`RunnerEnv` はT5で定義しT6,7,13,15が同一シグネチャを使用。`Store`メソッド名はT4宣言とT7,11,13,14の使用箇所で一致確認済み。

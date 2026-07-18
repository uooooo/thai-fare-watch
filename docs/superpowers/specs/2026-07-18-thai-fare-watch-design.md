# thai-fare-watch 設計書

- 日付: 2026-07-18
- リポジトリ: `github.com/uooooo/thai-fare-watch`（public）
- ステータス: 承認済み（アプローチ・設計の意思決定はユーザーからClaudeに委任。設計提示済み、実装まで進める指示あり）

## 1. 目的

東京起点でタイ（バンコク等）に片道でたどり着く「総額が安い」経路を常時監視し、しきい値（既定: ¥15,000、激安 ¥10,000）を下回ったら Discord に通知する個人用ツール。相場は通常 ¥20,000〜40,000。

特徴:

- **経路の自由度**: 直行便だけでなく、単一予約の乗継便、**別切り自己乗継**（例: 東京→ソウル + ソウル→バンコクを別々に購入）、**国内ポジショニング**（新幹線・バスで関西へ→KIX発、国内LCCで福岡・沖縄へ→そこから国際線）まで総額で比較する。
- **信頼フィルタ**: 通知対象は「航空会社公式直販」「Trip.com」「Booking.com」で買える価格のみ。無名格安OTA・詐欺まがい業者の価格は通知せず参考情報に格下げする。
- **agent-first**: コアは `tfw` CLI（全コマンド `--json` 対応）。Claude Code / Codex 等のAIエージェントが道具として使う前提で、SKILL.md / AGENTS.md を同梱。bot（定期監視）とwebダッシュボードはCLIコアの上に載る。

## 2. 確定要件

| 項目 | 内容 |
|---|---|
| 利用者 | 本人のみ（シングルユーザー） |
| ルート | 日本（東京起点、国内移動込み）→ タイ（BKK/DMK 主、CNX/HKT も対象）片道 |
| 監視窓 | `immediate`（当日+翌日、直前投げ売り狙い）と `near`（+2〜31日）。窓はプリセット+設定で切替・追加可能に抽象化 |
| しきい値 | 設定可能。既定 notify_max=¥15,000（🔥）、flash_max=¥10,000（💥） |
| 信頼予約先 | 航空会社公式 / Trip.com / Booking.com（Agodaは除外）。それ以外は通知不可・参考扱い |
| 通貨・地域 | 表示・判定は常にJPY正規化。市場（POS）差はレグ出発国市場で照会し、外貨決済手数料(既定2.2%)を上乗せして公平比較 |
| 通知 | Discord Webhook（URLは Secrets / `.env` のみ。コミット禁止） |
| 運用コスト | 無料枠中心（SerpAPI無料250検索/月 + Travelpayouts無料 + GitHub Actions public無料） |
| 実行基盤 | GitHub Actions cron（30分毎）。ローカルCLI実行も同一コード |
| 成果物 | CLI `tfw` / GitHub Actions bot / GitHub Pages ダッシュボード / Claude Code用スキル |

## 3. データソース事情（2026-07-18 調査結果の要約）

前提となる市場変化: **Amadeus Self-Service API は 2026-07-17 に完全廃止**。Kiwi Tequila API は新規受付終了。Skyscanner は公式APIがB2B審査制のみで、非公式アクセスはPerimeterX系の強力なbot対策により個人の安定運用は不可能（ブラウザ自動化でも、データセンターIPからはほぼ確実にブロックされ、住宅IPでもいたちごっこになる）。

採用ソースと役割:

| ソース | 役割 | コスト | 特性 |
|---|---|---|---|
| **Travelpayouts (Aviasales Data API)** | 一次スクリーニング（広域掃引） | 無料・目安200req/h | 直近48hに他ユーザーが検索した**キャッシュ最安値**。鮮度・網羅性は劣るが面を張れる。ZIPAIR等の直販専業は載らない |
| **SerpAPI (Google Flights API)** | 二次検証（実価格）+ **販売元取得** | 無料250検索/月 | Google Flightsのライブ検索。LCC網羅性最強（ZIPAIR・AirAsia X・Scoot・VietJet・Peach・Thai Lion確認済み）。Booking Options APIで販売元一覧と `airline: true/false` フラグが取れ、信頼フィルタが機械判定できる唯一の手段 |

Phase 2 候補（アダプタ差し込み口のみ用意）: fast-flights（Google Flights無料スクレイパー、v3系が活発にメンテ中だが上位数件截断+CI IPブロックの制約）、Playwright製Google Flightsブラウザアダプタ（ローカル住宅IP実行前提）、Sky Scrapper等のRapidAPI系。Skyscannerのライブスクレイピングは恒久非対応（信頼バッジの考え方だけをallowlist初期値に反映）。

## 4. アプローチ選定（決定済み）

- **A: 二段構え型（採用）** — Travelpayoutsで広く安く掃引し、閾値近傍のみSerpAPIで精査。信頼フィルタが成立し、コスト¥0、正規API 2本で長期安定。
- B: スクレイピング全振り型（不採用） — 販売元内訳が取れず信頼フィルタが成立しない。CI環境からのブロックリスク。
- C: Cloudflare Workers常駐型（不採用） — ローカルCLI（agent利用）と実行基盤が分裂し二重運用になる。

言語・ランタイム: **TypeScript / bun**（新規JSプロジェクトの既定。CLI・web・Actionsすべて単一言語で完結。両APIは素のHTTPで叩ける）。

## 5. アーキテクチャ

```
                 ┌─────────────────────────────────────────────┐
                 │                  tfw CLI (bun/TS)           │
                 │                                             │
  Travelpayouts ─┤► sources/travelpayouts ─┐                   │
  SerpAPI ───────┤► sources/serpapi ───────┤                   │
  (Phase2: browser/fast-flights adapters)  │                   │
                 │                    core/combiner            │
                 │   (直行/経由/別切り/国内ポジショニング合成)   │
                 │                         │                   │
                 │   core/trust ── core/thresholds ── dedupe   │
                 │                         │                   │
                 │        state/ (data/*.json[l] git管理)      │
                 │                         │                   │
                 │                  notify/discord             │
                 └─────────────────────────────────────────────┘
                        ▲                          ▲
        GitHub Actions cron (*/30)          ローカル/agent実行
        → data/ を main にコミット          (Claude Code skill 経由)
                        │
              GitHub Pages ダッシュボード (web/, データはraw URLから直読み)
```

実行モデル: 状態はすべて `data/` 配下のJSON/JSONLファイル（git scraping方式）。DBなし。Actionsが30分毎に `tfw watch --once` を実行し、変化があれば `data/` をコミット。履歴はgitが持つ。

## 6. コンポーネント設計

### 6.1 config（`src/config.ts`）

- zodスキーマで検証。`tfw.config.toml`（非秘密、コミット対象）+ 環境変数（秘密: `SERPAPI_API_KEY`, `TRAVELPAYOUTS_TOKEN`, `DISCORD_WEBHOOK_URL`。ローカルは `.env`、Actionsは Secrets）。
- 主な設定と既定値:
  - `origins`: `["TYO"]`（都市コード。TYO=NRT+HND）
  - `positioning`: `["OSA", "NGO", "FUK", "OKA"]`（国内前進基地。OSA=KIX等）
  - `hubs`: `["SEL", "TPE", "KUL", "SGN", "SIN", "HKG", "MNL"]`
  - `destinations`: `["BKK", "CNX", "HKT"]`（BKK=スワンナプーム+ドンムアン）
  - `thresholds`: `{ notify_max: 15000, flash_max: 10000, watch_margin: 1.2 }`
  - `windows`: `[{name:"immediate", from:0, to:1, every_minutes:30}, {name:"near", from:2, to:31, every_minutes:60}]`（from/toは今日からの日数オフセット。カスタム窓を配列に追加可能）
  - `trusted_otas`: `["trip.com", "booking.com"]`（正規化小文字部分一致）
  - `fx_fee_rate`: `0.022`（外貨決済上乗せ）
  - `combine`: `{ min_connect_hours: 4, max_connect_hours: 26, allow_next_day: true, max_total_hours: 40 }`
  - `serpapi`: `{ monthly_quota: 250, daily_budget_cap: 8 }`
  - `ground`: 地上アクセス静的料金表（下記6.4）

### 6.2 sources（`src/sources/`）

共通インターフェース:

```ts
interface FareSource {
  name: string;
  // 広域掃引: O/Dペア+日付範囲 → キャッシュ運賃観測値
  sweep?(pairs: OdPair[], window: DateRange): Promise<FareObservation[]>;
  // 精密検証: 特定O/D/日付 → ライブ運賃+販売元
  verify?(od: OdPair, date: string): Promise<VerifiedOffer[]>;
}
```

- **TravelpayoutsSource**（sweepのみ）: `GET /aviasales/v3/prices_for_dates`（one_way=true, currency=jpy）。**海外発レグは `market` をレグ出発国に合わせる**（SEL発→kr、TPE発→tw等。キャッシュ密度対策）。`found_at`/`expires_at` を保持し鮮度を記録。レート制御: 直列+150ms間隔（200req/h以内）。
- **SerpApiSource**（verifyのみ）: `google_flights` エンジン（gl=jp, hl=ja, currency=JPY, one-way, `best_flights`+`other_flights` 両方読む）→ 閾値以下の便のみ `booking_token` で Booking Options を追加取得（+1クォータ）。返り値に販売元リスト（`book_with`, `airline` フラグ, price, 予約URL）を含める。
- アダプタは登録制（`sources/index.ts`）で、Phase 2のブラウザ/fast-flightsアダプタを同じインターフェースで差せる。

### 6.3 core/combiner（経路合成）

入力: FareObservation群（国際直行 O→D、レグ O→H / H→D、国内航空 TYO→OSA/NGO/FUK/OKA）+ 地上アクセス表。出力: Itinerary（1〜3レグ+地上）。

- パターン: ①直行/単一予約（1観測=1経路） ②別切り2レグ（O→H + H→D） ③国内ポジショニング + ①or②（地上または国内線 + 国際レグ。国際部分が別切り2レグの場合は計3レグ）
- 乗継規則: 両レグの時刻が既知 → `min_connect_hours`(4h)〜`max_connect_hours`(26h) を強制。時刻不明（キャッシュデータの欠損）→ 同日ペア（⚠️時刻要確認フラグ）と翌日ペア（`allow_next_day`）を生成。
- 空港不一致: 到着空港≠出発空港（同一都市内、例: BKK着→DMK発）は接続6h未満を除外し警告付与。都市が違えば不成立。
- 総額 = Σ(レグ運賃 × 外貨手数料係数(海外市場レグのみ1.022)) + 地上アクセス費。`max_total_hours`(40h)超は除外。
- 出力は総額昇順、上位20件を保持。各経路に鮮度（最古観測時刻）と検証状態（unverified/verified/expired）を付与。

### 6.4 地上アクセス表（config内静的データ）

東京都心→各空港の片道最安目安（設定で上書き可能）: NRT ¥1,500（LCCバス）/ HND ¥600 / KIX ¥6,000（夜行バス。新幹線¥14,500も選択肢としてコメント記載）/ NGO ¥4,000（高速バス）。FUK・OKAは地上非現実のため国内線レグ（動的運賃）のみ。所要時間も持ち、乗継計算の参考値とする。

### 6.5 core/trust（信頼フィルタ）

Booking Options の各販売元を分類:

- `airline === true` → **trusted（航空会社直販）**。ZIPAIR/AirAsia等のLCC直販もここで拾える。
- `airline === false` かつ `book_with` 正規化名が `trusted_otas` に部分一致 → **trusted（信頼OTA）**。
- それ以外 → **reference（参考）**。通知対象外、ダッシュボードにのみ表示。

通知には trusted 販売元の最安値と予約先名・リンク（Google Flightsリンク+販売元名。直リンクが単純GETで得られる場合のみ直リンク併記）を載せる。

### 6.6 監視窓スケジューラ（core/windows）

Actionsのcronは30分毎の単一エントリ。実行時に各窓の `every_minutes` と `data/state.json` の窓別 lastRun を比べ、期限が来た窓だけ処理する（cron遅延に頑健）。窓ごとの処理 = sweep対象日付範囲の決定 → 掃引 → 合成 → 候補選定。

### 6.7 検証キューとクォータ管理

- SerpAPI月間クォータ（既定250）を `data/quota.json` で自己管理。日次予算 = min(残量/残日数, daily_budget_cap=8)。
- 検証優先度: ①総額 ≤ flash_max の候補 ②≤ notify_max ③≤ notify_max×watch_margin ④immediate窓の定点観測（TYO→BKK直行、1日1-2回）。
- 別切り経路は各レグを個別に検証（2レグ=検索2回+Booking Options）。予算不足時は部分検証とし、未検証レグを明示。
- Booking Options 呼び出しは「検証後価格が notify_max 以下」の場合のみ。

### 6.8 しきい値・重複抑制（core/thresholds, core/dedupe）

- 通知ティア: 💥 flash（≤¥10,000）/ 🔥 deal（≤¥15,000）/ ⚠️ candidate（閾値以下だが未検証。既定ON、明確にラベル分け）。
- dealキー = `経路(区間+便名列)|出発日|販売元クラス`。同キーは (a)初出 (b)前回通知比 max(¥500, 3%) 以上の値下がり のみ再通知。キーは出発日経過で自動失効。`data/notified.jsonl` に記録。

### 6.9 notify/discord

Discord Webhook にembed送信: ティア絵文字+総額JPY、経路サマリ（例: `東京(NRT) → ソウル(ICN) → バンコク(DMK)`）、日付、レグ別内訳（便名・金額・販売元・鮮度）、地上アクセス費、別切りリスク警告（自己乗継は乗継失敗自己責任・預け荷物再チェックイン）、予約リンク、検証状態。送信失敗はリトライ(3回, exponential backoff)後、`data/health.json` に記録。

### 6.10 CLI（`src/cli.ts`、コマンド名 `tfw`）

引数パーサは `citty`。全コマンド `--json`（機械可読、agent向け）と人間向け整形出力の両対応。`--config <path>`、`--dry-run`（通知・永続化なし）対応。

| コマンド | 動作 |
|---|---|
| `tfw watch [--once]` | 期限が来た窓の全パイプライン実行（Actionsが呼ぶエントリポイント） |
| `tfw sweep [--window <name>]` | 掃引のみ実行し候補を出力 |
| `tfw verify <FROM> <TO> <DATE>` | 指定区間をSerpAPIで即時検証（販売元込み） |
| `tfw deals` | 現在の有効deal一覧 |
| `tfw history <FROM> <TO>` | 価格履歴（JSONL集計） |
| `tfw quota` | SerpAPIクォータ残量 |
| `tfw notify-test` | Discordテスト送信 |
| `tfw config` | 解決済み設定の表示 |

終了コード: 0=成功 / 1=致命的エラー / 2=一部ソース失敗（部分結果あり）。agentがハンドリングできるようドキュメント化。

### 6.11 state（`data/` ファイルレイアウト）

- `data/state.json` — 窓別lastRun等のランタイム状態
- `data/quota.json` — SerpAPI使用量（月次）
- `data/fares/YYYY-MM.jsonl` — 運賃観測ログ（総額が notify_max×2 以下のもののみ記録し肥大化防止）
- `data/deals.json` — 現在の有効deal+候補（ダッシュボードの主データ）
- `data/notified.jsonl` — 通知履歴
- `data/health.json` — ソース別の直近実行結果・連続失敗数

### 6.12 web（`web/`、GitHub Pages）

Vite + React + TypeScript + Tailwind CSS v4 + Recharts。日本語UI・ダークモード対応。データは `raw.githubusercontent.com/uooooo/thai-fare-watch/main/data/*` を実行時fetch（ビルド不要でデータ最新、Pages再デプロイはweb変更時のみ）。

画面: ①Overview — 現在の最安カード（直行/経由/別切り別）、しきい値との距離、ヘルス表示 ②History — 区間セレクタ+価格推移チャート ③Notifications — 通知ログフィード。

### 6.13 automation（`.github/workflows/`）

- `watch.yml` — `schedule: cron '7,37 * * * *'`（毎時00分の混雑を避けるオフセット）+ `workflow_dispatch`。bun setup（キャッシュ）→ `tfw watch --once` → `data/` に差分があればコミット&プッシュ。`concurrency: watch`（多重起動防止）、`permissions: contents: write`。Secrets: `SERPAPI_API_KEY`, `TRAVELPAYOUTS_TOKEN`, `DISCORD_WEBHOOK_URL`。
- `pages.yml` — `web/**` 変更時+手動で Vite build → `actions/deploy-pages`。
- `ci.yml` — PR/push時に `bun test` + lint（Biome）。

### 6.14 agent連携（skills/・AGENTS.md）

- `skills/thai-fare-watch/SKILL.md` — Claude Code用スキル。frontmatter（name/description）+ CLIコマンドリファレンス、`--json` 出力スキーマ例、典型タスクレシピ（「今の最安を確認して」「この日付を即検証して」「しきい値を変えて」）。`~/.claude/skills/` へのsymlinkで導入。
- `AGENTS.md` — リポジトリ内で作業するagent向け（Codex等）: 開発規約、コマンド、データファイルの意味。`CLAUDE.md` は `AGENTS.md` への参照のみ。

## 7. データモデル（主要型）

```ts
type FareObservation = {
  id: string;              // hash
  source: "travelpayouts" | "serpapi" | string;
  origin: string; destination: string;   // IATA都市/空港コード
  departDate: string;      // YYYY-MM-DD (現地)
  departAt?: string;       // ISO8601 (既知の場合)
  arriveAt?: string;
  airline?: string; flightNumber?: string;
  transfers: number;       // 単一予約内の乗継数
  priceJpy: number;        // JPY正規化済み(手数料含まず)
  market: string;          // 照会市場 (jp, kr, ...)
  foundAt: string; expiresAt?: string;   // 鮮度
};

type SellerOffer = {
  seller: string;          // book_with
  isAirlineDirect: boolean;
  trust: "airline" | "trusted_ota" | "reference";
  priceJpy: number;
  bookingUrl?: string;
};

type VerifiedOffer = FareObservation & { sellers: SellerOffer[] };

type Itinerary = {
  id: string;
  kind: "direct" | "through" | "self_transfer" | "positioned";
  legs: (FareObservation | GroundLeg)[];
  totalJpy: number;        // 手数料・地上込み
  fxFeeJpy: number;
  risks: string[];         // "自己乗継", "時刻要確認", "空港移動あり" 等
  verification: "unverified" | "partial" | "verified";
  tier?: "flash" | "deal" | "candidate";
};

type GroundLeg = { mode: "train" | "bus"; from: string; to: string; priceJpy: number; hours: number };
```

## 8. 通貨・市場ポリシー

1. すべての取得・判定・表示はJPY（Travelpayouts `currency=jpy`、SerpAPI `currency=JPY&gl=jp`）。
2. キャッシュ照会の `market` はレグ出発国に合わせる（日本発=jp、ソウル発=kr…）。理由: 現地市場のほうが検索キャッシュが濃く、現地セール運賃を拾えるため。
3. 海外市場レグには `fx_fee_rate`（既定2.2%）を上乗せした実効JPYで総額比較（外貨決済・海外OTA決済の実コスト近似）。
4. 多市場同時比較（同一便をjp/th/kr市場で見比べて最安市場で買う）はPhase 2。

## 9. エラー処理・ヘルス

- ソース単位で独立にtry/catch。片系死亡時は残る系で継続し、終了コード2。
- HTTP: タイムアウト15s、リトライ3回（429/5xxのみ、exponential backoff + jitter）。429連発時はそのソースを当該実行でスキップ。
- 連続失敗が閾値（6回=約3時間）を超えたらDiscordにヘルス警告を1日1回まで送信。
- クォータ枯渇時: 検証をスキップし候補は⚠️candidateとして扱う（通知は候補ティアのみ）。
- Actionsのコミット競合: pull --rebase して再push（1回リトライ）。

## 10. テスト戦略

- `bun:test`。外部APIは実レスポンス形状のフィクスチャJSON（`test/fixtures/`）+ fetchモック。ライブAPIはCIで叩かない。
- 重点ユニット: trust分類（airline/OTA名正規化）、combiner（乗継バッファ・翌日接続・空港不一致・手数料・地上合成・総時間上限）、windowsスケジューラ（lastRun境界）、dedupe（値下がり再通知・失効）、quota予算計算、両アダプタのレスポンスパース。
- 統合: `tfw watch --once --dry-run` をモックfetchで貫通させ、生成される通知ペイロードとdata書き込みをスナップショット検証。

## 11. セキュリティ

- 秘密情報は `.env`（gitignore済み）と GitHub Secrets のみ。`tfw config` は秘密をマスク表示。
- Discord Webhook URLは書き込み可能な秘密として扱う（漏れたら再発行）。
- publicリポジトリのため、コミットされる `data/` に個人情報は含めない（価格観測のみ）。

## 12. セットアップ（ユーザー作業）

1. SerpAPI 無料登録 → APIキー取得（https://serpapi.com/）
2. Travelpayouts 無料登録 → APIトークン取得（https://www.travelpayouts.com/）
3. キー2つをClaudeに渡す → `.env` と `gh secret set` を実施（Discord Webhookは受領済み）
4. キー未設定の間: Travelpayouts未設定なら掃引不可、SerpAPI未設定なら検証不可（候補ティアのみ動作）。CLIは欠けている機能を明示してエラーにする。

## 13. Phase 2（スコープ外、差し込み口のみ用意）

- Playwright製 Google Flights ブラウザアダプタ（ローカル住宅IP実行、SerpAPIクォータ節約・Booking Options無料化）
- fast-flights アダプタ（subprocess経由、広域ベースライン掃引）
- self-hosted runner（自宅Mac）での実行オプション
- 多市場価格比較（jp/th/kr POS同時照会）
- LINE通知（Messaging API）、しきい値のダッシュボードからの編集
- 往復・複数都市対応

## 14. リスクと対応

| リスク | 対応 |
|---|---|
| Travelpayoutsの日本市場キャッシュが薄い | 海外レグは現地市場照会で密度確保。SerpAPI定点観測が最後の砦。実運用データで密度を計測し、薄ければPhase 2アダプタを前倒し |
| SerpAPI無料枠の逼迫 | クォータ自己管理+優先度キュー。逼迫が常態化したら$25/月プラン検討（ユーザー判断） |
| キャッシュ価格が既に消えている（買えない） | 通知に鮮度と検証状態を明記。verified以外は期待値を下げる文言 |
| 別切り乗継失敗リスク | 通知に固定文言で警告。バッファ既定4h+翌日接続推奨 |
| GitHub Actions cronの遅延・間引き | 窓スケジューラがlastRun基準で動くため遅延に頑健。オフセットcron採用 |

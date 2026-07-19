# thai-fare-watch 設計書

- 日付: 2026-07-18（v3: ユーザー指示によりブラウザ操作を主軸に変更。ローカルブラウザ+クラウドAPIのハイブリッド構成）
- リポジトリ: `github.com/uooooo/thai-fare-watch`（public）
- ステータス: 承認済み（アプローチ・設計の意思決定はユーザーからClaudeに委任。「ブラウザ操作が本命」の方針指示を反映。実装まで進める指示あり）

## 1. 目的

東京起点でタイ（バンコク等）に片道でたどり着く「総額が安い」経路を常時監視し、しきい値（既定: ¥15,000、激安 ¥10,000）を下回ったら Discord に通知する個人用ツール。相場は通常 ¥20,000〜40,000。

特徴:

- **経路の自由度**: 直行便だけでなく、単一予約の乗継便、**別切り自己乗継**（例: 東京→ソウル + ソウル→バンコクを別々に購入）、**国内ポジショニング**（新幹線・バスで関西へ→KIX発、国内LCCで福岡・沖縄へ→そこから国際線）まで総額で比較する。
- **信頼フィルタ**: 通知対象は「航空会社公式直販」「Trip.com」「Booking.com」で買える価格のみ。無名格安OTA・詐欺まがい業者の価格は通知せず参考情報に格下げする。
- **agent-first**: コアは `tfw` CLI(全コマンド `--json` 対応)。Claude Code / Codex 等のAIエージェントが道具として使う前提で、SKILL.md / AGENTS.md を同梱。bot（定期監視）とwebダッシュボードはCLIコアの上に載る。

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
| 運用コスト | ¥0（ブラウザ自動化 + 無料API + GitHub Actions public無料） |
| 実行基盤 | **主軸: ローカルMac（住宅IP）のブラウザ自動化** + 保険: GitHub Actions cron（APIソースのみ、Macスリープ中の面カバー） |
| 成果物 | CLI `tfw` / launchd定期実行 + GitHub Actions bot / GitHub Pages ダッシュボード / Claude Code用スキル |

## 3. データソース事情（2026-07-18 調査結果の要約）

前提となる市場変化: **Amadeus Self-Service API は 2026-07-17 に完全廃止**。Kiwi Tequila API は新規受付終了（公式MCP `mcp.kiwi.com` が個人向け唯一の窓口だが、キュレーション済み出力・販売元が常にKiwi.comのため監視主軸に不適）。Skyscanner は公式API/MCPともB2B審査制のみ、RapidAPI系2次ラッパーは無料枠月20回に縮小。**SkyscannerはPerimeterX系の多層bot対策（TLS指紋・行動解析）によりブラウザ自動化でも安定運用は困難**。

Skyscannerの扱い（ユーザー指示 v3.1 で更新 — 従来「恒久非対応」としていたが、ローカルの実Chrome+住宅IPという条件下では取得の余地があるとの判断で「ローカル専用・ベストエフォート」ソースとして正式採用、Task 15b）: **CI（データセンターIP）では無効**、ローカルでは実Chromeの永続プロファイル（warmup前提）+ 非ヘッドレスで低頻度に試行し、PerimeterX/CAPTCHA検知時はクールダウンして自動後退する（他ソースが肩代わり）。実際、実装時のライブ採取では px-captcha ブロックを実測しており、恒常的な取得は保証しない。固有価値は Skyscanner の Recommended Provider バッジで、これを信頼フィルタ（`classifySeller` の `recommendedBadge`）に加算する。

**Google Flightsはブラウザ自動化に寛容**（住宅IPからの低頻度アクセスなら実質素通り、fast-flights/fli等の非ブラウザ直叩きOSSが成立している程度の防御）で、かつ**予約オプションパネルに販売元一覧（航空会社直販/Trip.com/Booking.com等）が表示される**ため、価格取得と信頼フィルタの両方をブラウザで完結できる。これを主軸に据える。

採用ソース（役割順）:

| ソース | 役割 | コスト | 実行場所 | 特性 |
|---|---|---|---|---|
| **Google Flights ブラウザ (Playwright)** | **主砲**: 深掃引（日付グリッド=1ページ約2ヶ月分の最安値）+ 最終検証（予約オプションパネルで販売元取得） | 無料・キー不要 | ローカルMac | 住宅IPで安定。重い（1検索5〜15秒）ので礼儀正しいレート制御。セレクタ変更リスクはfli/SerpAPIフォールバックで吸収 |
| **fli (punitarani/fli)** | 高頻度軽量スキャン（`search_dates`で日付範囲最安を一括） | 無料・無制限（非公式） | 両方 | Google Flights内部API直叩きOSS（MIT、活発）。ブラウザ不要で速い。CIのDC IPではブロックされうる→サーキットブレーカ |
| **Travelpayouts (Aviasales Data API)** | 24時間の面カバー（キャッシュ最安値の広域掃引、特に海外ハブ発レグ） | 無料・目安200req/h | 両方（主にActions） | 公式API。直近48hの検索キャッシュ。ZIPAIR等の直販専業は載らない |
| **セール速報RSS (Traicy等)** | イベント駆動シグナル | 無料・bot可（実測200 OK） | 両方 | 日本発LCCセール発表を補足。キーワードマッチで即通知+臨時掃引トリガー |
| **SerpAPI (Google Flights API)** | 任意フォールバック（ブラウザ長期不在時の販売元検証） | 無料250検索/月（要登録、**任意**） | Actions | Booking Options APIで`airline`フラグ+販売元名。キー未設定なら単にスキップ |

## 4. アプローチ選定（決定済み）

- **採用: ブラウザ主軸ハイブリッド** — ローカルMacのPlaywright（Google Flights）が深掃引と販売元検証を無料で担い、Macスリープ中はGitHub Actions上のAPIソース（fli/Travelpayouts/RSS）が面を張る。状態はgitで同期し、どちらのランナーも同じ`data/`にコミットする。
- 不採用: API二段構え型（SerpAPIクォータ依存・登録必須）→ フォールバックに降格。スクレイピング全振り型（販売元不明）、Workers常駐型（CLI分裂）。Skyscannerライブ取得はローカル専用・ベストエフォートとして限定採用（Task 15b、上記§3参照）。

言語・ランタイム: **TypeScript / bun**。ブラウザ自動化は **Playwright**（`channel: "chrome"` で実Chrome使用、指紋を自然に保つ）。fliはJS版（`fli-js`）を第一候補、品質不足ならPython版CLIを `uvx` サブプロセスで叩く（アダプタ内に隠蔽、実装時に判定）。

## 5. アーキテクチャ

```
┌── ローカルMac (住宅IP, launchd 30分毎) ──────────────┐
│  sources/gf-browser (Playwright+Chrome)  ← 主砲      │
│  sources/fli, sources/travelpayouts, signals/rss     │
└──────────────┬───────────────────────────────────────┘
               │ data/ を git commit/push（実行前に pull --rebase）
               ▼
        ┌─ GitHub repo (main) ─┐        ┌── GitHub Actions (7,37 * * * *) ──┐
        │  data/*.json[l]      │ ◄──────│ sources/fli(CB付), travelpayouts, │
        │  = 共有状態・履歴     │        │ signals/rss, (serpapi任意)         │
        └──────────┬───────────┘        └───────────────────────────────────┘
                   │raw URL fetch
                   ▼
         GitHub Pages ダッシュボード (web/)

パイプライン（両ランナー共通、能力に応じてステップをスキップ）:
  掃引/スキャン(TP+fli+GF grid) ─► core/combiner(直行/経由/別切り/国内ポジショニング)
    ─► trust/thresholds/dedupe ─► 検証(fli価格確認 → GFブラウザ販売元検証[ローカルのみ]
                                     └ 不在時: SerpAPI販売元検証[任意] / ⚠️candidate通知)
    ─► notify/discord ─► state永続化
```

実行モデル: 状態はすべて `data/` 配下のJSON/JSONL（git scraping方式、DBなし）。ローカルとActionsの二重書き込みは「実行前 `git pull --rebase` → 実行 → 差分コミット → push（競合時rebaseリトライ1回）」で調停。追記型JSONLが主なので競合面は小さい。

## 6. コンポーネント設計

### 6.1 config（`src/config.ts`）

- zodスキーマで検証。`tfw.config.toml`（非秘密、コミット対象）+ 環境変数（秘密: `DISCORD_WEBHOOK_URL` 必須、`TRAVELPAYOUTS_TOKEN` 推奨、`SERPAPI_API_KEY` 任意。ローカルは `.env`、Actionsは Secrets）。
- 主な設定と既定値:
  - `origins`: `["TYO"]`（都市コード。TYO=NRT+HND）
  - `positioning`: `["OSA", "NGO", "FUK", "OKA"]`（国内前進基地。OSA=KIX等）
  - `hubs`: `["SEL", "TPE", "KUL", "SGN", "SIN", "HKG", "MNL"]`
  - `destinations`: `["BKK", "CNX", "HKT"]`（BKK=スワンナプーム+ドンムアン）
  - `thresholds`: `{ notify_max: 15000, flash_max: 10000, watch_margin: 1.2 }`
  - `windows`: `[{name:"immediate", from:0, to:1, every_minutes:30}, {name:"near", from:2, to:31, every_minutes:60}]`（from/toは今日からの日数オフセット。カスタム窓を配列で追加可能）
  - `trusted_otas`: `["trip.com", "booking.com"]`（正規化小文字部分一致）
  - `fx_fee_rate`: `0.022`（外貨決済上乗せ）
  - `combine`: `{ min_connect_hours: 4, max_connect_hours: 26, allow_next_day: true, max_total_hours: 40 }`
  - `browser`: `{ enabled: "auto"(ローカル判定), min_interval_sec: 45, jitter_sec: 20, deep_sweep_every_hours: 3, headless: true, channel: "chrome" }`
  - `fli`: `{ enabled: true, ci_circuit_breaker: { consecutive_failures: 3, cooldown_hours: 6 } }`
  - `serpapi`: `{ monthly_quota: 250, daily_budget_cap: 8 }`（キーがある場合のみ有効）
  - `rss_feeds`: `[{name:"traicy-sale", url:"https://www.traicy.com/category/airline/sale/feed", every_minutes: 60}, {name:"sky-budget", url:"https://sky-budget.com/feed/", every_minutes: 120}]` + マッチキーワード（タイ/バンコク/プーケット/チェンマイ/ドンムアン + 対象航空会社名）
  - `ground`: 地上アクセス静的料金表（下記6.5）

### 6.2 sources（`src/sources/`）

共通インターフェース:

```ts
interface FareSource {
  name: string;
  available(env: RunnerEnv): boolean;   // ブラウザ有無・キー有無・CB状態で判定
  // 広域掃引/スキャン: O/Dペア+日付範囲 → 運賃観測値
  sweep?(pairs: OdPair[], window: DateRange): Promise<FareObservation[]>;
  // 精密検証: 特定O/D/日付 → ライブ運賃（+取れる場合は販売元）
  verify?(od: OdPair, date: string): Promise<VerifiedOffer[]>;
}
```

- **GoogleFlightsBrowserSource**（sweep+verify、販売元あり。**主砲、ローカルのみ**）:
  - Playwright + 実Chrome（`channel:"chrome"`）、日本語UI・JPY固定URL（`gl=jp&hl=ja&curr=JPY`相当のパラメータ）。
  - sweep: O/Dペアごとに日付グリッド（カレンダー表示）を開き、表示範囲（約2ヶ月）の日別最安値を一括収集。1ページ=数十観測で効率が高い。`deep_sweep_every_hours`(3h)毎に全ペア巡回（約50ペア×10秒≒10分/回）。
  - verify: 対象日の検索結果を開き、該当便をクリック→**予約オプションパネルから販売元一覧（名称+価格+リンク種別）を取得**。販売元名が運航会社と一致→航空会社直販、それ以外はOTA名としてtrust分類へ。
  - 礼儀: リクエスト間 `min_interval_sec`+jitter、同時1タブ、深夜帯の実行密度低減。ブロック/CAPTCHA検知時は当該実行を中断しヘルス記録（次回スケジュールで自然リトライ）。
  - セレクタは `data-testid`/aria属性優先で脆さを低減。パネル構造変化の検知（0販売元が続く等）でヘルス警告。
- **FliSource**（sweep+verify、販売元なし）: `search_dates` で窓内最安日一括スキャン、`search_flights` でライブ価格確認（`sellers: []`）。CI環境での連続失敗はサーキットブレーカで自動休止。
- **TravelpayoutsSource**（sweep）: `GET /aviasales/v3/prices_for_dates`（one_way=true, currency=jpy）。**海外発レグは `market` をレグ出発国に合わせる**（SEL発→kr等）。`found_at`/`expires_at` で鮮度記録。直列+150ms間隔。
- **SerpApiSource**（verify、販売元あり。**任意フォールバック**）: キー設定時のみ有効。Booking Options で `book_with`/`airline` フラグ取得。クォータ自己管理（6.8）。
- アダプタは登録制（`sources/index.ts`）。ランナー環境（ローカル/CI）と設定で `available()` が決まる。

### 6.3 signals（`src/signals/rss.ts`）

- 設定されたRSSフィードを窓スケジューラと同じ仕組みでポーリング。既読管理はitem guid（`data/state.json`）。
- マッチルール（v1はキーワードベース）: ①タイ関連地名 or ②対象航空会社名+国際線文脈語（「アジア」「国際線」「セール」）。マッチしたら ℹ️セール速報 として即Discord通知（1 guid 1回）+ 関連窓の臨時掃引をトリガー。
- LLMによる本文解析はPhase 2（agentは今でも `tfw news` で読める）。

### 6.4 core/combiner（経路合成）

入力: FareObservation群（国際直行 O→D、レグ O→H / H→D、国内航空 TYO→OSA/NGO/FUK/OKA）+ 地上アクセス表。出力: Itinerary（1〜3レグ+地上）。

- パターン: ①直行/単一予約（1観測=1経路） ②別切り2レグ（O→H + H→D） ③国内ポジショニング + ①or②（地上または国内線 + 国際レグ。国際部分が別切りなら計3レグ）
- 乗継規則: 両レグの時刻が既知 → `min_connect_hours`(4h)〜`max_connect_hours`(26h) を強制。時刻不明（キャッシュ/グリッドデータ）→ 同日ペア（⚠️時刻要確認フラグ）と翌日ペア（`allow_next_day`）を生成。
- 空港不一致: 到着空港≠出発空港（同一都市内、例: BKK着→DMK発）は接続6h未満を除外し警告付与。都市が違えば不成立。
- 総額 = Σ(レグ運賃 × 外貨手数料係数(海外市場レグのみ1.022)) + 地上アクセス費。`max_total_hours`(40h)超は除外。
- 出力は総額昇順、上位20件を保持。各経路に鮮度（最古観測時刻）と検証状態を付与。

### 6.5 地上アクセス表（config内静的データ）

東京都心→各空港の片道最安目安（設定で上書き可能）: NRT ¥1,500（LCCバス）/ HND ¥600 / KIX ¥6,000（夜行バス。新幹線¥14,500も選択肢としてコメント記載）/ NGO ¥4,000（高速バス）。FUK・OKAは地上非現実のため国内線レグ（動的運賃）のみ。所要時間も持ち、乗継計算の参考値とする。

### 6.6 core/trust（信頼フィルタ）

販売元情報（GFブラウザの予約オプションパネル、またはSerpAPI Booking Options）を分類:

- 航空会社直販（GF: 正規化後の販売元名が運航会社名と**完全一致** / SerpAPI: `airline === true`）→ **trusted**。ZIPAIR/AirAsia等のLCC直販もここで拾える。正規化は NFKC→小文字→「で予約」等の接尾辞除去→英数字以外除去。
- OTA名の正規化名が `trusted_otas` エントリと**完全一致** → **trusted（信頼OTA）**。部分一致・前方一致は不採用（Mytrip.com⊃trip.com、trip.com.evil等のなりすまし経路を遮断。偽陽性は致命的・偽陰性は安全側）。CJK併記（「Trip.com（トリップ）」）は正規化で消えるため一致する。ラテン文字の表記ゆれ（"Trip.com (Japan)"等）が実在した場合は `trusted_otas` に明示追加して対応する。
- それ以外 → **reference（参考）**。通知対象外、ダッシュボードにのみ表示。

通知には trusted 販売元の最安値と予約先名・リンク（Google Flightsリンク+販売元名。直リンクが単純GETで得られる場合のみ直リンク併記）を載せる。

### 6.7 監視窓スケジューラ（core/windows）

ローカル（launchd 30分毎）とActions（cron 30分毎）の両方が同じエントリポイント `tfw watch --once` を実行。各窓・RSSフィード・深掃引ジョブの `every_minutes`/`every_hours` と `data/state.json` の lastRun を比べ、期限が来たものだけ処理（cron遅延・スリープ復帰に頑健）。ジョブには必要能力タグ（`browser` 等）があり、能力がないランナーはスキップする（例: GF深掃引はローカルのみ、Actionsでは自動スキップ）。

### 6.8 検証パイプライン

3+1段階の検証レベル: `unverified`（キャッシュ/グリッド観測のみ）→ `price_confirmed`（fliまたはGF検索でライブ価格確認）→ `verified`（販売元まで確認済み。別切りは全レグで`verified`、一部なら`partial`）。

1. 合成後の候補（総額 ≤ notify_max×watch_margin）をまず **fliで価格確認**（無料・軽量）。消えていれば棄却。
2. `price_confirmed` かつ総額 ≤ notify_max の候補: **ローカルならGFブラウザで販売元検証**（無料）→ trust分類 → 通知ティア決定。
3. ローカル不在（Actions実行）の場合: SerpAPIキーがあればフォールバック検証（検索1+Booking Options 1=2クォータ/レグ、日次予算 = min(残量/残日数, 8)、優先度: ①≤flash_max ②≤notify_max ③immediate窓）。キーがなければ ⚠️candidate として通知し、`data/state.json` の検証キューに積む → 次回ローカル実行が拾ってGFブラウザで昇格検証（verified化したら🔥/💥で再通知）。
4. fli故障時（CB開）: Travelpayouts候補を直接ステップ2/3へ。GFブラウザ故障時: fli価格確認+（あれば）SerpAPIで縮退。

### 6.9 しきい値・重複抑制（core/thresholds, core/dedupe）

- 通知ティア: 💥 flash（≤¥10,000, verified）/ 🔥 deal（≤¥15,000, verified）/ ⚠️ candidate（閾値以下だが未検証/部分検証）/ ℹ️ sale-news（RSSセール速報）。
- dealキー = `経路(区間+便名列)|出発日|販売元クラス`。同キーは (a)初出 (b)前回通知比 max(¥500, 3%) 以上の値下がり (c)candidate→verified昇格 のみ再通知。キーは出発日経過で自動失効。`data/notified.jsonl` に記録。

### 6.10 notify/discord

Discord Webhook にembed送信: ティア絵文字+総額JPY、経路サマリ（例: `東京(NRT) → ソウル(ICN) → バンコク(DMK)`）、日付、レグ別内訳（便名・金額・販売元・鮮度・検証状態）、地上アクセス費、別切りリスク警告（自己乗継は乗継失敗自己責任・預け荷物再チェックイン）、予約リンク。送信失敗はリトライ(3回, exponential backoff)後、`data/health.json` に記録。

### 6.11 CLI（`src/cli.ts`、コマンド名 `tfw`）

引数パーサは `citty`。全コマンド `--json`（機械可読、agent向け）と人間向け整形出力の両対応。`--config <path>`、`--dry-run`（通知・永続化なし）対応。

| コマンド | 動作 |
|---|---|
| `tfw watch [--once]` | 期限が来た窓+RSS+検証キューの全パイプライン実行（launchd/Actions共通エントリ） |
| `tfw sweep [--window <name>] [--deep]` | 掃引/スキャンのみ（--deepでGFブラウザ日付グリッド掃引を強制） |
| `tfw verify <FROM> <TO> <DATE> [--sellers]` | 指定区間を即時検証（--sellersで販売元まで: ローカル=GFブラウザ/Actions=SerpAPI） |
| `tfw deals` | 現在の有効deal一覧 |
| `tfw history <FROM> <TO>` | 価格履歴（JSONL集計） |
| `tfw news` | RSSセール速報の直近マッチ一覧 |
| `tfw quota` | SerpAPIクォータ残量（キー設定時のみ） |
| `tfw notify-test` | Discordテスト送信 |
| `tfw config` | 解決済み設定の表示（秘密はマスク） |
| `tfw setup-local` | launchd plist生成+ロード（30分毎実行、ログパス設定込み） |

終了コード: 0=成功 / 1=致命的エラー / 2=一部ソース失敗（部分結果あり）。agentがハンドリングできるようドキュメント化。

### 6.12 state（`data/` ファイルレイアウト）

- `data/state.json` — 窓・RSS・深掃引のlastRun、RSS既読guid、CB状態、検証キュー
- `data/quota.json` — SerpAPI使用量（月次、キー設定時のみ）
- `data/fares/YYYY-MM.jsonl` — 運賃観測ログ（総額が notify_max×2 以下のもののみ記録し肥大化防止）
- `data/deals.json` — 現在の有効deal+候補（ダッシュボードの主データ）
- `data/notified.jsonl` — 通知履歴
- `data/health.json` — ソース別の直近実行結果・連続失敗数

git調停: 実行前 `pull --rebase` → 実行 → 差分あればcommit+push（失敗時rebaseして1回リトライ）。ローカルとActionsが同一ファイル群を共有する。

### 6.13 web（`web/`、GitHub Pages）

Vite + React + TypeScript + Tailwind CSS v4 + Recharts。日本語UI・ダークモード対応。データは `raw.githubusercontent.com/uooooo/thai-fare-watch/main/data/*` を実行時fetch（ビルド不要でデータ最新、Pages再デプロイはweb変更時のみ）。

画面: ①Overview — 現在の最安カード（直行/経由/別切り別）、しきい値との距離、ランナー稼働状況（ローカル最終実行/Actions最終実行）②History — 区間セレクタ+価格推移チャート ③Notifications — 通知ログ+セール速報フィード。

### 6.14 automation

- **ローカル（主軸）**: `tfw setup-local` が launchd plist（`~/Library/LaunchAgents/tech.incerto.tfw.plist`、StartInterval 1800秒、スリープ中は発火せず復帰後の次周期で実行）を生成・ロード。ログは `~/Library/Logs/tfw/`。Playwright + 実Chrome使用。
- `.github/workflows/watch.yml` — `schedule: cron '7,37 * * * *'` + `workflow_dispatch`。bun setup（キャッシュ）→ `tfw watch --once`（browserジョブは自動スキップ）→ `data/` 差分をコミット&プッシュ。`concurrency: watch`、`permissions: contents: write`。Secrets: `DISCORD_WEBHOOK_URL`（必須）, `TRAVELPAYOUTS_TOKEN`（推奨）, `SERPAPI_API_KEY`（任意）。
- `.github/workflows/pages.yml` — `web/**` 変更時+手動で Vite build → `actions/deploy-pages`。
- `.github/workflows/ci.yml` — PR/push時に `bun test` + lint（Biome）。

### 6.15 agent連携（skills/・AGENTS.md）

- `skills/thai-fare-watch/SKILL.md` — Claude Code用スキル。frontmatter（name/description）+ CLIコマンドリファレンス、`--json` 出力スキーマ例、典型タスクレシピ（「今の最安を確認して」「この日付を即検証して」「しきい値を変えて」）。`~/.claude/skills/` へのsymlinkで導入。
- `AGENTS.md` — リポジトリ内で作業するagent向け（Codex等）: 開発規約、コマンド、データファイルの意味。`CLAUDE.md` は `AGENTS.md` への参照のみ。

## 7. データモデル（主要型）

```ts
type FareObservation = {
  id: string;              // hash
  source: "gf-browser" | "fli" | "travelpayouts" | "serpapi" | string;
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
  seller: string;
  isAirlineDirect: boolean;
  trust: "airline" | "trusted_ota" | "reference";
  priceJpy: number;
  bookingUrl?: string;
};

type VerifiedOffer = FareObservation & { sellers: SellerOffer[] };  // fli/TPはsellers=[]

type Itinerary = {
  id: string;
  kind: "direct" | "through" | "self_transfer" | "positioned";
  legs: (FareObservation | GroundLeg)[];
  totalJpy: number;        // 手数料・地上込み
  fxFeeJpy: number;
  risks: string[];         // "自己乗継", "時刻要確認", "空港移動あり" 等
  verification: "unverified" | "price_confirmed" | "partial" | "verified";
  tier?: "flash" | "deal" | "candidate";
};

type GroundLeg = { mode: "train" | "bus"; from: string; to: string; priceJpy: number; hours: number };

type SaleNews = { guid: string; feed: string; title: string; url: string; matchedKeywords: string[]; publishedAt: string };
```

## 8. 通貨・市場ポリシー

1. すべての取得・判定・表示はJPY（GFブラウザ/fli/SerpAPI 日本POS+JPY、Travelpayouts `currency=jpy`）。
2. キャッシュ照会の `market` はレグ出発国に合わせる（日本発=jp、ソウル発=kr…）。理由: 現地市場のほうが検索キャッシュが濃く、現地セール運賃を拾えるため。
3. 海外市場レグには `fx_fee_rate`（既定2.2%）を上乗せした実効JPYで総額比較（外貨決済・海外OTA決済の実コスト近似）。
4. 多市場同時比較（同一便をjp/th/kr市場で見比べて最安市場で買う）はPhase 2。

## 9. エラー処理・ヘルス

- ソース単位で独立にtry/catch。片系死亡時は残る系で継続し、終了コード2。
- HTTP: タイムアウト15s、リトライ3回（429/5xxのみ、exponential backoff + jitter）。429連発時はそのソースを当該実行でスキップ。
- GFブラウザ: CAPTCHA/ブロック/0件連続を検知したら当該実行を中断しヘルス記録（次周期で自然リトライ）。パネル構造変化疑い（販売元0が3回連続）でDiscordヘルス警告。
- fli: CI環境で連続3回失敗→サーキットブレーカ6時間、縮退運転。復帰自動。
- 連続失敗が閾値（6回=約3時間）を超えたソースはDiscordにヘルス警告を1日1回まで送信。ローカルランナーが12時間以上未実行（Mac長期スリープ）の場合もActions側が1日1回警告。
- Actionsのコミット競合: pull --rebase して再push（1回リトライ）。

## 10. テスト戦略

- `bun:test`。外部APIは実レスポンス形状のフィクスチャJSON（`test/fixtures/`）+ fetchモック。GFブラウザは保存済みHTML/DOMスナップショットに対するパーサ単体テスト+実ブラウザの手動スモーク（CIではブラウザ起動しない）。
- 重点ユニット: trust分類（直販判定・OTA名正規化）、combiner（乗継バッファ・翌日接続・空港不一致・手数料・地上合成・総時間上限）、windowsスケジューラ（lastRun境界・能力タグスキップ）、dedupe（値下がり再通知・昇格再通知・失効）、quota予算、検証パイプライン段階遷移、RSSマッチャ、各アダプタのパース。
- 統合: `tfw watch --once --dry-run` をモックfetchで貫通させ、通知ペイロードとdata書き込みをスナップショット検証。

## 11. セキュリティ

- 秘密情報は `.env`（gitignore済み）と GitHub Secrets のみ。`tfw config` は秘密をマスク表示。
- Discord Webhook URLは書き込み可能な秘密として扱う（漏れたら再発行）。
- publicリポジトリのため、コミットされる `data/` に個人情報は含めない（価格観測のみ）。
- ブラウザ自動化は自分のMac上・ログイン不要ページのみ・礼儀正しいレートで運用（Google ToS上のリスクは個人利用範囲として許容、ブロックされたら自然停止する設計）。

## 12. セットアップ

1. （必須・受領済み）Discord Webhook → `.env` と `gh secret set`
2. （推奨）Travelpayouts 無料登録 → トークン（https://www.travelpayouts.com/）— Actions側の面カバーが厚くなる
3. （任意）SerpAPI 無料登録 → キー（https://serpapi.com/）— Macが長期不在でも販売元検証が続く
4. ローカル: `bun install` → `bunx playwright install chrome`（実Chrome連携）→ `tfw setup-local`
5. キー未設定時の縮退動作はCLIが明示する（fli+GFブラウザ+RSSはキー不要で全機能動作）。

## 13. Phase 2（スコープ外、差し込み口のみ用意）

- Skyscanner「アシストモード」（無人監視ではなく、agentがPlaywright MCP+ユーザーの実ブラウザで対話的にSkyscannerを確認する手順書。恒久的な無人取得は非対応）
- Kiwi.com公式MCP（`mcp.kiwi.com`）を対話的な補助検索としてagentに追加（監視パイプラインには組み込まない）
- self-hosted runner化（Actions のブラウザジョブを自宅Macで実行）
- RSS本文のLLM解析（路線・価格の構造化抽出）
- 多市場価格比較（jp/th/kr POS同時照会）
- LINE通知（Messaging API）、しきい値のダッシュボードからの編集
- 往復・複数都市対応

## 14. リスクと対応

| リスク | 対応 |
|---|---|
| Macスリープ中の監視空白 | Actions側のfli/TP/RSSが24時間面を張る。閾値到達はcandidate通知+検証キュー→Mac復帰時に自動昇格検証。12時間以上ローカル不在で警告 |
| GF画面構造の変更（セレクタ破損） | パーサをDOMスナップショットでテスト・販売元0連続検知で警告。fli（同データ源・別経路）+SerpAPI（任意）で縮退 |
| GFからのブロック/CAPTCHA | 礼儀正しいレート（45秒+jitter、同時1タブ、実Chrome指紋）。検知時は中断→次周期リトライ。恒常化したら頻度自動減 |
| fliの破損・CIでのブロック | サーキットブレーカで自動休止/復帰。GFブラウザ・TPで継続 |
| Travelpayoutsの日本市場キャッシュが薄い | 海外レグは現地市場照会で密度確保。GF深掃引が主データ源なので影響限定 |
| キャッシュ/グリッド価格が既に消えている | 3段階検証レベルを通知に明記。verified以外は期待値を下げる文言 |
| 別切り乗継失敗リスク | 通知に固定文言で警告。バッファ既定4h+翌日接続推奨 |
| Actions cronの遅延・間引き | lastRun基準スケジューラで頑健。オフセットcron採用 |
| RSSフィードの構造変更・停止 | フィードは設定配列で交換可能。失敗はヘルスに載るのみ |

# thai-fare-watch

東京発・タイ行き片道の格安航空券を自動監視し、狙い目の価格になったら Discord に通知するパーソナルツール。

## 目的

東京 → タイ（バンコク中心。チェンマイ・プーケットも対象）の片道航空券は、相場でおおよそ ¥20,000〜40,000。このツールは常時価格を監視し、**¥15,000 以下（🔥 deal）/ ¥10,000 以下（💥 flash）** を狙って Discord に通知する。

- 直行便だけでなく、経由便、**別切り自己乗継**（例: 東京→ソウルとソウル→バンコクを別々に購入）、**国内ポジショニング**（新幹線・バスで大阪へ移動して KIX 発にする、国内LCCで福岡・沖縄へ移動してそこから国際線に乗る、等）までを**総額**で比較する。
- 通知するのは**信頼できる予約先**（航空会社公式サイト / Trip.com / Booking.com）で買える価格のみ。それ以外の販売元（無名OTA・確認できない業者）で見つかった価格は参考情報として扱い、通知はしない。

## アーキテクチャ

複数のデータソースを役割分担させ、ローカルMacとGitHub Actionsのハイブリッドで24時間監視する。

| ソース | 役割 | コスト | 状態 |
|---|---|---|---|
| **fli** | 無料の Google Flights 内部APIを直接叩くOSS。高頻度の軽量スキャン | 無料・キー不要 | ✅ 実装済み |
| **Travelpayouts** | キャッシュ最安値の広域掃引（Macスリープ中の面カバーに強い） | 無料（無料枠あり） | ✅ 実装済み |
| **セール速報RSS** | LCCセール発表をキーワードマッチで即時検知 | 無料 | ✅ 実装済み |
| **SerpAPI** | 任意の販売元検証フォールバック（ローカル不在時） | 無料250検索/月（任意登録） | ✅ 実装済み |
| **Google Flights ブラウザ (Playwright)** | ローカル主砲。日付グリッドの深掃引 + 予約オプションパネルからの販売元検証 | 無料・キー不要 | ✅ 実装済み |
| **Skyscanner ブラウザ (Playwright)** | ローカル専用・ベストエフォート。「おすすめの提供会社」バッジ→trusted_ota連携。CI(データセンターIP)では無効 | 無料・キー不要 | ✅ 実装済み（best-effort — PerimeterX対策で高頻度にblocked/cooldownになる想定。他ソースが荷を負う） |

- **実行基盤**: ローカルMac（`launchd` 定期実行、住宅IPでブラウザ自動化）+ GitHub Actions（`cron`、APIソースのみ）のハイブリッド。どちらも同じ `tfw watch --once` を実行する。
- **状態管理**: DBを持たず "git scraping" 方式で、`data/` 配下のJSON/JSONLに状態を永続化し、git commit/pushで両ランナー間で共有する。
- **信頼フィルタ**: 販売元名を正規化（NFKC→小文字化→記号除去）した上で、航空会社名または `trusted_otas` との**完全一致のみ**を信頼できる価格として扱う。部分一致・前方一致は採用しない（なりすまし販売元経路の遮断を優先し、偽陰性は安全側として許容する）。

## セットアップ

```bash
bun install
bunx playwright install chrome   # ローカルのブラウザ自動化に必要（Google Flights/Skyscannerアダプタが使用）
cp .env.example .env             # DISCORD_WEBHOOK_URL を設定（必須）
```

> 🚧 現状の実装ステータス: コア（設定・多層ソースのうち fli / Travelpayouts / RSS / SerpAPI・経路合成・信頼フィルタ・通知・監視パイプライン・CLI）とブラウザ主砲（Google Flights = Task 15）は動作する。Skyscanner(Task 15b)はローカル専用のbest-effortアダプタとして実装済みだが、PerimeterX等のbot対策により高頻度でblocked/cooldownになる想定（設計上、他ソースが荷を負う）。launchd 常駐（Task 16）のみ未実装。ローカルのブラウザが無い/CI環境では `tfw watch` は fli + Travelpayouts + RSS + (任意)SerpAPI で動作する。

任意で以下も `.env` に設定するとカバレッジが増える。

- `TRAVELPAYOUTS_TOKEN` — https://www.travelpayouts.com/ で無料登録
- `SERPAPI_API_KEY` — https://serpapi.com/ で無料登録（250検索/月）

ローカルの定期実行は `tfw setup-local` で有効化する（launchd plist生成+ロード。**Task16で有効化予定**）。

GitHub Actions で動かす場合は、リポジトリの Settings → Secrets and variables → Actions に上記3つ（`DISCORD_WEBHOOK_URL` は必須、他2つは任意）を登録する。

## CLIコマンド

`tfw`（`bun run tfw <command>`、実体は `bun run src/cli.ts <command>`）。全コマンド `--json`（機械可読出力）に対応し、`--config <path>` / `--dry-run`（通知・永続化なし）も共通で使える。

| コマンド | 動作 |
|---|---|
| `tfw watch [--once]` | 期限が来た監視窓・RSS・検証キューを一括実行（launchd/Actions共通のエントリーポイント） |
| `tfw sweep [--window <name>] [--deep]` | 掃引/スキャンのみ実行（`--deep` でGoogle Flightsブラウザの日付グリッド掃引を強制） |
| `tfw verify <FROM> <TO> <DATE> [--sellers]` | 指定区間・日付を即時検証（`--sellers` で販売元まで: ローカルはGFブラウザ、Actionsはあれば SerpAPI） |
| `tfw deals` | 現在有効な deal 一覧 |
| `tfw history <FROM> <TO>` | 価格履歴（`data/fares/*.jsonl` の集計） |
| `tfw news` | セール速報RSSの直近マッチ一覧 |
| `tfw quota` | SerpAPI クォータ残量（キー設定時のみ） |
| `tfw notify-test` | Discord へテスト通知を送信 |
| `tfw config` | 解決済み設定を表示（秘密はマスク） |
| `tfw setup-local` | launchd plist生成+ロード（30分毎実行） |

**終了コード**: `0` = 成功 / `1` = 致命的エラー / `2` = 一部ソース失敗（部分結果あり）。agentがハンドリングできるようにこの3値を返す。

## データファイル

すべて `data/` 配下。git scraping方式で状態を保持するため、手編集はしない（[AGENTS.md](./AGENTS.md) 参照）。

| ファイル | 内容 |
|---|---|
| `data/state.json` | 監視窓・RSS・深掃引の lastRun、RSS既読guid、サーキットブレーカ状態、検証キュー |
| `data/quota.json` | SerpAPI 使用量（月次、キー設定時のみ） |
| `data/fares/YYYY-MM.jsonl` | 運賃観測ログ（月別JSONL） |
| `data/deals.json` | 現在有効な deal + 候補一覧（ダッシュボードの主データ） |
| `data/notified.jsonl` | 通知履歴 |
| `data/health.json` | ソース別の直近実行結果・連続失敗数 |

## ⚠️ 別切り自己乗継について（免責）

別切り自己乗継（複数の予約を組み合わせた乗継ルート）を含む経路を通知する場合がある。利用にあたっては以下を各自の責任で確認すること。

- 乗継に失敗した場合の責任は自己負担（航空会社・OTAは別切り区間をまたいだ保証をしない）。
- 預け荷物は乗継地点で一度受け取り、次のフライトの再チェックインが必要。
- 経由国のビザ・トランジット（入国）要件は各自で確認する。
- 通知される価格は取得時点のものであり、購入操作をしている間に売り切れる・変動する可能性がある。

## コスト

運用コストが実質 ¥0 になることを目標にした構成。

- fli / セール速報RSS: 無料・無制限（非公式ツール/公開フィード）
- GitHub Actions: publicリポジトリなら無料
- SerpAPI: 無料枠 250検索/月（任意登録。なくても fli + GFブラウザ + RSS で主要機能は動作）
- Travelpayouts: 無料（無料登録のみ）

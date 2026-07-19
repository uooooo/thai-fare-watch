# AGENTS.md

このリポジトリ（thai-fare-watch）で作業するAIエージェント（Claude Code, Codex 等）向けの規約。

## ランタイム

- **bun必須。Node.js（`node`/`npm`/`npx`）は使わない。** TypeScriptはそのまま `bun run <file>.ts` で実行する。
- 依存インストール: `bun install`（ロックファイルは `bun.lock`。手で編集しない）
- CLI実行: `bun run tfw <command> [--json]`（`package.json` の `bin`/`scripts` 経由。実体は `bun run src/cli.ts <command>`）
  - 例: `bun run tfw deals --json` / `bun run tfw verify NRT BKK 2026-08-02 --sellers --json`
  - 全コマンド `--json` で機械可読出力に対応（人間向けの整形出力と共存）。`--config <path>` / `--dry-run`（通知・永続化なし）も共通オプション。
  - 終了コード: `0`=成功 / `1`=致命的エラー / `2`=一部ソース失敗（部分結果あり）。スクリプト/agentから呼ぶ場合はこの3値をハンドリングする（詳細は README.md）。

## テスト

- テストランナーは `bun:test`（`bun test` で全件実行）。テストは `test/*.test.ts`、フィクスチャは `test/fixtures/`。
- 実装を変更したら必ず `bun test` を通すこと。可能なら失敗するテストを先に書いてから実装する。

## Lint / Format

- Biome（`biome.json`）。インデントはタブ、クオートはダブルクオート。
- コミット前に `bunx biome check .`（自動修正）または `bunx biome ci .`（CIと同じ非破壊チェック）を実行する。`.github/workflows/ci.yml` は `bunx biome ci .` と `bun test` の両方が緑であることを要求する。

## コミット規約

Conventional Commits（`feat:`/`fix:`/`test:`/`docs:`/`chore:`）+ 日本語の説明文。このリポジトリの既存履歴の慣習に従う。

- `feat:` 新機能 / `fix:` 不具合修正 / `test:` テスト追加・修正 / `docs:` ドキュメントのみ / `chore:` ビルド・設定・雑務
- 例: `feat: fliアダプタ(uvxサブプロセス, CIサーキットブレーカ)` / `fix: 信頼判定を正規化後の完全一致に厳格化(部分一致/前方一致のなりすまし経路を全遮断)`

## `data/` ファイルの意味

すべて `tfw watch` 等のCLI実行が読み書きする状態ファイル。

| ファイル | 内容 |
|---|---|
| `data/state.json` | 監視窓・RSS・深掃引の lastRun、RSS既読guid、サーキットブレーカ状態、検証キュー |
| `data/quota.json` | SerpAPI 使用量（月次、キー設定時のみ） |
| `data/fares/YYYY-MM.jsonl` | 運賃観測ログ（月別JSONL） |
| `data/deals.json` | 現在有効な deal + 候補一覧（ダッシュボードの主データ） |
| `data/notified.jsonl` | 通知履歴 |
| `data/health.json` | ソース別の直近実行結果・連続失敗数 |

詳細な説明は README.md の「データファイル」節も参照。

## やってはいけないこと

- **秘密のコミット禁止**: `DISCORD_WEBHOOK_URL` / `TRAVELPAYOUTS_TOKEN` / `SERPAPI_API_KEY` などの秘密情報は `.env`（gitignore済み・ローカル用）または GitHub Secrets（Actions用）にのみ置く。`tfw.config.toml`・ソースコード・ワークフローYAMLに平文で書かない。`tfw config` は秘密を必ずマスクして表示する実装を維持する。
- **`data/` の手編集禁止**: `data/` 配下のJSON/JSONLはCLI（`tfw watch`/`sweep`/`verify` 等）が生成・更新する状態ファイル。手で書き換えると鮮度情報や重複抑制キー（`notified.jsonl`）の整合性が壊れる。直す必要がある場合はソースコード側（`src/state/store.ts` 等）かCLIコマンドの実装を直す。
- **ライブAPI/実ネットワークを叩くテスト追加禁止**: 新しいテストからGoogle Flights・Travelpayouts・SerpAPI・Discord等へ本物のHTTPリクエストや実プロセスを送らない。既存の注入ポイントを使ってモックする。
  - HTTP系（`src/util/http.ts`, `src/notify/discord.ts`, `src/signals/rss.ts`, `src/sources/serpapi.ts`, `src/sources/travelpayouts.ts`）は `fetchImpl` を差し替える。
  - `src/sources/fli.ts`（`uvx` サブプロセス呼び出し）は `RunFn` を差し替える。
  - 保存済みレスポンスは `test/fixtures/` に置く。
- **`.superpowers/` はスクラッチ**: リポジトリルートの `.superpowers/` は `.gitignore` 済みの作業用ディレクトリで、参照・依存しない（内容がある前提で作業しない）。恒久的な設計ドキュメント・実装計画は `docs/superpowers/specs/` と `docs/superpowers/plans/`（こちらはgit管理下・別物）にある。

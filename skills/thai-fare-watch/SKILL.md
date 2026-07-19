---
name: thai-fare-watch
description: 東京→タイ格安航空券監視botの操作。今の最安確認・特定日の即時検証・しきい値変更・通知履歴の確認を行うときに使う
---

# thai-fare-watch 操作スキル

## 前提

- このリポジトリ（thai-fare-watch）のルートでコマンドを実行する（`bun install` 済みであること）。
- CLIは `bun run tfw <command> [--json]`（実体は `bun run src/cli.ts <command>`）。

## コマンドレシピ

| やりたいこと | コマンド |
|---|---|
| 今の最安は? | `bun run tfw deals --json` |
| 8/2を検証して | `bun run tfw verify NRT BKK 2026-08-02 --sellers --json` |
| しきい値を変えたい | `tfw.config.toml` の `[thresholds]`（`notify_max`/`flash_max`）を編集して commit |
| 監視状況は? | `bun run tfw config --json` と `data/health.json` を確認 |
| 通知履歴を見たい | `data/notified.jsonl` を確認、または `bun run tfw history <FROM> <TO> --json` |
| セール速報を見たい | `bun run tfw news --json` |
| SerpAPIクォータ残量は? | `bun run tfw quota --json` |

## `--json` 出力の主要フィールド

- `tfw deals --json` → `Itinerary[]`: `totalJpy`（総額JPY）、`kind`（`direct`/`through`/`self_transfer`/`positioned`）、`tier`（`flash`/`deal`/`candidate`）、`verification`（`unverified`/`price_confirmed`/`partial`/`verified`）、`risks`（自己乗継等の注意事項の配列）、`legs`（内訳）。
- `tfw verify <FROM> <TO> <DATE> --sellers --json` → `VerifiedOffer[]`: `FareObservation` の全フィールド + `sellers`（`seller`/`isAirlineDirect`/`trust`/`priceJpy`/`bookingUrl`）。`--sellers` を付けないと `sellers` は空配列になりうる。
- `tfw config --json` → 解決済み設定（`tfw.config.toml` + 環境変数のマージ後）。Webhook URL・APIキー等の秘密は必ずマスクされる。
- `data/health.json`（CLI出力ではなくファイル直読み）→ ソース別の直近実行結果・連続失敗数。監視状況の裏取りに使う。

## 終了コードの解釈

- `0`: 成功。出力をそのまま使ってよい。
- `1`: 致命的エラー。処理は失敗。stderrの内容をそのままユーザーに伝える。
- `2`: 一部ソース失敗（部分結果あり）。出力自体は使えるが、一部ソースが欠けている可能性がある旨を伝える（詳細は `data/health.json` で確認できる）。

## 導入

```bash
ln -s <このリポジトリのフルパス>/skills/thai-fare-watch ~/.claude/skills/thai-fare-watch
```

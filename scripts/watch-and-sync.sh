#!/usr/bin/env bash
# launchd(tech.incerto.tfw、30分毎)から呼ばれる同期スクリプト。
# pull→watch --once実行→data/配下の変更をcommit&push、までを1回のプロセスで行う。
# 途中の失敗(pull/watch/push)はできるだけ次回実行に回復を委ねる(`|| true`)—
# cron的な定期実行を止めないことを優先し、失敗はwatch.jsonl/tfw.logへ残す。
set -euo pipefail
cd "$(dirname "$0")/.."

# launchdはPATHをほぼ渡さないため、bun(mise管理)とHomebrewの場所を明示的に通す。
export PATH="$HOME/.local/share/mise/installs/bun/latest/bin:/opt/homebrew/bin:$PATH"

# .envがあれば読み込む(DISCORD_WEBHOOK_URL等)。無ければ既定値のみで動く(config.ts側の仕様通り)。
[ -f .env ] && set -a && source .env && set +a

# ローカル/他端末での先行pushを取り込む。コンフリクトの芽はautostashで吸収する。
git pull --rebase --autostash --quiet || true

LOG_DIR="${TFW_LOG_DIR:-$HOME/Library/Logs/tfw}"
mkdir -p "$LOG_DIR"

# watchの失敗(ネットワーク断等)でこのプロセス自体を落とさない—記録だけ残して次回に委ねる。
bun run src/cli.ts watch --once --json >>"$LOG_DIR/watch.jsonl" 2>&1 || true

# state.json/fares/*.jsonl等はwatch実行前は未追跡(untracked)のことがあるため、まず
# `git add -A`で新規ファイルもインデックスに載せてから`git diff --cached`で判定する
# (add前の`git diff --quiet`は未追跡ファイルの変更を検出できず取り込み漏れになる)。
git add -A -- data/
if ! git diff --cached --quiet -- data/; then
	git commit --quiet -m "data: watch $(date +%Y-%m-%dT%H:%M)"
	git push --quiet || { git pull --rebase --quiet && git push --quiet; }
fi

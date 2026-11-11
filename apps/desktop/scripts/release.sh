#!/usr/bin/env bash
# 发布一个版本：改版本号（电脑和安卓）、提交、打带发布说明的标签；加 --push 推到 GitHub，
# "Build app" 工作流会打包、签名，发布到 Releases，装好的 Flax 从那里自动更新。
#
#   npm run release -- 0.1.2 -m "新增：……" --push
#   npm run release -- 0.1.2 -F notes.md --push
set -euo pipefail
cd "$(dirname "$0")/../../.."

usage() { echo "用法：$0 <版本号> (-m <发布说明> | -F <文件>) [--push]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
version="${1#v}"; shift
notes=""; push=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) notes="$2"; shift 2 ;;
    -F) notes="$(cat "$2")"; shift 2 ;;
    --push) push=1; shift ;;
    *) usage ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "不是版本号：$version" >&2; exit 2; }
[[ -n "$notes" ]] || { echo "要写发布说明（-m 或 -F）：更新提示里显示的就是它" >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo "先提交或暂存手上的改动" >&2; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "在 main 分支上发布" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && { echo "v$version 已经有了" >&2; exit 1; }

# 应用的版本号（apps/desktop/package.json）是自动更新比较的那个
node - "$version" <<'JS'
const fs = require('fs')
const v = process.argv[2]
const p = 'apps/desktop/package.json'
const s = fs.readFileSync(p, 'utf8')
fs.writeFileSync(p, s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`))
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
if (lock.packages?.['apps/desktop']) lock.packages['apps/desktop'].version = v
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
// 安卓和 iOS 用同一个版本号（手机上的检查更新拿它和最新发布比）。versionCode 是 Android 判断新旧的数字，
// 只能往上涨：1.2.3 → 1002003（预发布版和正式版同一个数）
const a = 'apps/mobile/app.json'
const app = JSON.parse(fs.readFileSync(a, 'utf8'))
const [ma, mi, pa] = v.split('-')[0].split('.').map(Number)
app.expo.version = v
app.expo.android.versionCode = ma * 1000000 + mi * 1000 + pa
app.expo.ios = { ...app.expo.ios, buildNumber: String(app.expo.android.versionCode) }
fs.writeFileSync(a, JSON.stringify(app, null, 2) + '\n')
JS

if [[ -n "$(git status --porcelain)" ]]; then git commit --quiet -am "Release v$version"; fi
git tag -a "v$version" -m "$notes"
echo "已打标签 v$version"
if [[ $push -eq 1 ]]; then
  git push --quiet origin main "v$version"
  echo "已推送；打包完成后在 https://github.com/linlih/flax/releases 出现"
else
  echo "发布：git push origin main v$version"
fi

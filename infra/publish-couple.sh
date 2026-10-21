#!/bin/zsh
# 夫婦用ページ（ログイン・ふたりのアルバムつき）を組み立てて、CloudFront に置く。
# 一般公開版（GitHub Pages）は index.html をそのまま使い、ログイン機能のファイルは読み込まない。
set -euo pipefail
cd "$(dirname "$0")/.."
AWS=${AWS:-aws}
export AWS_DEFAULT_REGION=ap-northeast-1
[ -f cloud-config.js ] || { echo "cloud-config.js がありません。先に infra/deploy.sh を実行してください"; exit 1; }
BUCKET=$(python3 -c 'import re;t=open("cloud-config.js").read();print(re.search(r"\"siteBucket\": \"([^\"]+)\"",t).group(1))')
DIST=$(python3 -c 'import re;t=open("cloud-config.js").read();print(re.search(r"\"distributionId\": \"([^\"]+)\"",t).group(1))')

rm -rf dist-couple && mkdir dist-couple
cp app.js missions.js badges.js style.css cloud.js cloud-config.js dist-couple/
# app.js より前に、設定とログイン機能を読み込ませる
VER=$(grep -o 'app.js?v=[0-9]*' index.html | cut -d= -f2)
python3 - "$VER" <<'PY'
import sys
v = sys.argv[1]
s = open("index.html", encoding="utf-8").read()
tag = f'<script src="app.js?v={v}"></script>'
assert tag in s
s = s.replace(tag, f'<script src="cloud-config.js?v={v}"></script>\n<script src="cloud.js?v={v}"></script>\n{tag}')
s = s.replace("<title>ふたり散歩</title>", "<title>ふたり散歩（ふたり用）</title>")
open("dist-couple/index.html", "w", encoding="utf-8").write(s)
PY

# index.html は毎回最新を取りにいく。ほかのファイルは ?v= で入れ替わるので長くキャッシュしてよい
$AWS s3 sync dist-couple "s3://$BUCKET" --delete --exclude index.html --cache-control "public, max-age=86400" --only-show-errors
$AWS s3 cp dist-couple/index.html "s3://$BUCKET/index.html" --cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors
$AWS cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" --query Invalidation.Status --output text
echo "公開しました: $(python3 -c 'import re;t=open("cloud-config.js").read();print(re.search(r"\"site\": \"([^\"]+)\"",t).group(1))')"

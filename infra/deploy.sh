#!/bin/zsh
# ふたりのアルバムのサーバーを、AWS（東京リージョン）に作る・更新する
set -euo pipefail
cd "$(dirname "$0")"
AWS=${AWS:-aws}
REGION=ap-northeast-1
STACK=futari-sanpo

EMAILS=$(tr -d ' \n' < allowed-emails.txt)
VAPID_PUBLIC=$(cat vapid-public.txt)
VAPID_PRIVATE=$(openssl ec -in vapid-private.pem -outform DER 2>/dev/null | base64 | tr -d '\n')
out() { $AWS cloudformation describe-stacks --region $REGION --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }

# 1. 設計図（CloudFormation）どおりに作る。変更がなければ何もしない。
#    夫婦用ページのURLは作ってから決まるので、わかったらもう一度反映して、そのURLからだけAPIを使えるようにする
deploy() {
  $AWS cloudformation deploy --region $REGION --stack-name $STACK --template-file template.yaml \
    --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
    --parameter-overrides "AllowedEmails=$EMAILS" "AllowedOrigins=$1" "VapidPublic=$VAPID_PUBLIC" "VapidPrivate=$VAPID_PRIVATE"
}
SITE=$(out SiteUrl); [ "$SITE" = "None" ] && SITE=""
deploy "${SITE:+$SITE,}http://localhost:8765"
if [ -z "$SITE" ]; then
  SITE=$(out SiteUrl)
  deploy "$SITE,http://localhost:8765"
fi

# 2. サーバーの処理（Lambda）を入れ替える
rm -f /tmp/futari-sanpo-api.zip
(cd api && zip -q /tmp/futari-sanpo-api.zip index.mjs)
for fn in futari-sanpo-api futari-sanpo-weekly; do
  $AWS lambda update-function-code --region $REGION --function-name $fn \
    --zip-file fileb:///tmp/futari-sanpo-api.zip --query LastModified --output text
  $AWS lambda wait function-updated --region $REGION --function-name $fn
done

# 3. アプリが使う設定（公開して問題ない値だけ）を書き出す
$AWS cloudformation describe-stacks --region $REGION --stack-name $STACK --query "Stacks[0].Outputs" --output json |
  python3 -c '
import json, sys
o = {x["OutputKey"]: x["OutputValue"] for x in json.load(sys.stdin)}
print("// deploy.sh が書き出す設定。公開して問題ない値だけ")
print("const CLOUD = " + json.dumps({"region": "ap-northeast-1", "api": o["ApiUrl"], "userPoolId": o["UserPoolId"], "clientId": o["ClientId"], "site": o["SiteUrl"], "siteBucket": o["SiteBucketName"], "distributionId": o["DistributionId"], "vapidPublic": open("vapid-public.txt").read().strip()}, indent=2) + ";")
' > ../cloud-config.js
cat ../cloud-config.js

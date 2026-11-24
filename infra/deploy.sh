#!/usr/bin/env bash
# =============================================================================
# Route & Stop: build everything on Floci with one command.
#
#   export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
#   bash infra/deploy.sh
#
# Safe to run again. Every step either creates the thing or updates it, so a
# second run is not an error and does not make a duplicate.
#
# Every name starts with "route-stop-" so nothing here can touch Ali's
# resources, which all start with "favorites-alerts-".
#
# What it builds, and why each one is here:
#   KMS key              encrypts the secret with a key we own and can rotate
#   IAM role + policy    what the function may do, and nothing else
#   Secrets Manager      the Neon link and the Turnstile key, out of the code
#   Lambda               the API itself (requirement: run on Floci, not Vercel)
#   API Gateway          the public address, with throttling
#   EventBridge          the weekly trip generation (replaces Vercel Cron)
#   SNS + Lambda         cancellation events out to the alerts service
#   CloudWatch           logs, a SECURITY metric filter, and an alarm
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="${AWS_ACCOUNT_ID:-000000000000}"   # Floci always uses this account id
PREFIX="route-stop"

API_FN="${PREFIX}-api"
FORWARDER_FN="${PREFIX}-event-forwarder"
ROLE="${PREFIX}-api-role"
POLICY="${PREFIX}-api-policy"
SECRET="${PREFIX}/app"
KEY_ALIAS="alias/${PREFIX}"
TOPIC="school-bus-route-events"          # agreed with Ali; his queue subscribes to it
HTTP_API="${PREFIX}-http-api"
LOG_GROUP="/aws/lambda/${API_FN}"
ZIP="dist/route-stop-api.zip"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n==> %s\n' "$1"; }

# Floci accepts the same commands as AWS but does not implement every one.
# Where a call is optional, this wrapper lets the script carry on instead of
# stopping the whole deployment.
try() { "$@" >/dev/null 2>&1 || return 1; }

# -----------------------------------------------------------------------------
say "Checking what is needed"

command -v aws >/dev/null || { echo "The aws CLI is not installed."; exit 1; }
command -v node >/dev/null || { echo "Node is not installed."; exit 1; }

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "Cannot reach AWS/Floci. Is Docker running and Floci started?"
  echo "  docker compose -f infra/floci/docker-compose.yml up -d"
  echo "  export AWS_PROFILE=floci MSYS_NO_PATHCONV=1"
  exit 1
fi

# The connection string is read from the environment, never stored in this
# file and never printed. It only travels as far as Secrets Manager.
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env ]; then
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
  fi
fi
[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL is not set. Put it in .env (which git ignores)."; exit 1; }

CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173,http://localhost:4566}"

# -----------------------------------------------------------------------------
say "1/9  KMS key for our secret"

if ! aws kms describe-key --key-id "$KEY_ALIAS" >/dev/null 2>&1; then
  KEY_ID=$(aws kms create-key \
    --description "Route & Stop service secrets" \
    --query KeyMetadata.KeyId --output text)
  aws kms create-alias --alias-name "$KEY_ALIAS" --target-key-id "$KEY_ID"
  # Rotation means a stolen old key stops being useful on its own.
  try aws kms enable-key-rotation --key-id "$KEY_ID" || echo "    (Floci may not implement key rotation; real AWS does)"
  echo "    created $KEY_ALIAS"
else
  KEY_ID=$(aws kms describe-key --key-id "$KEY_ALIAS" --query KeyMetadata.KeyId --output text)
  echo "    $KEY_ALIAS already exists"
fi
KEY_ARN="arn:aws:kms:${REGION}:${ACCOUNT}:key/${KEY_ID}"

# -----------------------------------------------------------------------------
say "2/9  SNS topic for cancellation events"

TOPIC_ARN=$(aws sns create-topic --name "$TOPIC" --query TopicArn --output text)
echo "    $TOPIC_ARN"
# Created first, and by us, because Ali's deploy.sh subscribes his queue to
# it. Run this script before his on the demo machine.

# -----------------------------------------------------------------------------
say "3/9  IAM role and a least-privilege policy"

cat > /tmp/${PREFIX}-trust.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
JSON

# Each statement names one resource. No "*" anywhere except the log-stream
# wildcard inside our own log group, which is how CloudWatch names streams.
cat > /tmp/${PREFIX}-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OwnLogsOnly",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${PREFIX}-*"
    },
    {
      "Sid": "OwnSecretOnly",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${SECRET}*"
    },
    {
      "Sid": "OwnKeyOnly",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "${KEY_ARN}"
    },
    {
      "Sid": "PublishRouteEventsOnly",
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "${TOPIC_ARN}"
    }
  ]
}
JSON

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file:///tmp/${PREFIX}-trust.json >/dev/null
  echo "    created role $ROLE"
else
  echo "    role $ROLE already exists"
fi

# put-role-policy overwrites, so a re-run always applies the current policy.
aws iam put-role-policy --role-name "$ROLE" \
  --policy-name "$POLICY" \
  --policy-document file:///tmp/${PREFIX}-policy.json
echo "    policy $POLICY applied"

ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE}"
rm -f /tmp/${PREFIX}-trust.json /tmp/${PREFIX}-policy.json

# -----------------------------------------------------------------------------
say "4/9  Secret (Neon link, Turnstile key), encrypted with our key"

# Built in a temporary file with no echo, so the connection string never
# appears in the terminal or in the shell history.
SECRET_FILE=$(mktemp)
chmod 600 "$SECRET_FILE"
node -e '
  const out = { DATABASE_URL: process.env.DATABASE_URL };
  if (process.env.TURNSTILE_SECRET_KEY) out.TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
  if (process.env.INTERNAL_API_KEY) out.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
  require("fs").writeFileSync(process.argv[1], JSON.stringify(out));
' "$SECRET_FILE"

if aws secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET" \
    --secret-string "file://${SECRET_FILE}" >/dev/null
  echo "    updated $SECRET"
else
  aws secretsmanager create-secret --name "$SECRET" \
    --kms-key-id "$KEY_ARN" \
    --secret-string "file://${SECRET_FILE}" >/dev/null
  echo "    created $SECRET"
fi
rm -f "$SECRET_FILE"

# -----------------------------------------------------------------------------
say "5/9  Building the deployment package"

npm install --omit=dev --no-audit --no-fund >/dev/null
npm run zip
[ -f "$ZIP" ] || { echo "$ZIP was not produced."; exit 1; }

# -----------------------------------------------------------------------------
say "6/9  Lambda: the API"

# Only three settings on the function, and none of them is a secret:
# the secret's NAME, the allowed browser origins, and the mode.
ENV_VARS="Variables={SECRET_ID=${SECRET},CORS_ORIGINS=${CORS_ORIGINS},NODE_ENV=production}"

if aws lambda get-function --function-name "$API_FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$API_FN" \
    --zip-file "fileb://${ZIP}" >/dev/null
  # Floci can report the function as still updating; a short wait avoids a
  # "ResourceConflictException" on the configuration call that follows.
  sleep 2
  aws lambda update-function-configuration --function-name "$API_FN" \
    --environment "$ENV_VARS" --timeout 30 --memory-size 512 >/dev/null
  echo "    updated $API_FN"
else
  aws lambda create-function --function-name "$API_FN" \
    --runtime nodejs20.x --handler lambda.handler \
    --role "$ROLE_ARN" --zip-file "fileb://${ZIP}" \
    --timeout 30 --memory-size 512 \
    --environment "$ENV_VARS" >/dev/null
  echo "    created $API_FN"
fi

# -----------------------------------------------------------------------------
say "7/9  API Gateway, with throttling"

API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${HTTP_API}'].ApiId | [0]" --output text 2>/dev/null || true)

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigatewayv2 create-api --name "$HTTP_API" \
    --protocol-type HTTP --query ApiId --output text)
  echo "    created api $API_ID"
else
  echo "    api $API_ID already exists"
fi

INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[0].IntegrationId | [0]" --output text 2>/dev/null || true)

if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "arn:aws:lambda:${REGION}:${ACCOUNT}:function:${API_FN}" \
    --query IntegrationId --output text)
fi

# Only our own routes, plus OPTIONS for the browser's preflight. No
# catch-all: a route that does not exist should be refused at the gateway
# rather than waking the function up.
ROUTES=(
  "GET /api/health" "GET /api/ready"
  "GET /api/routes" "POST /api/routes"
  "GET /api/routes/{id}" "PUT /api/routes/{id}" "DELETE /api/routes/{id}"
  "POST /api/routes/{id}/stops" "PUT /api/routes/{id}/stops/order"
  "GET /api/routes/{id}/schedule" "PUT /api/routes/{id}/schedule"
  "PUT /api/stops/{id}" "DELETE /api/stops/{id}"
  "GET /api/buses" "POST /api/buses"
  "GET /api/trips" "POST /api/trips"
  "GET /api/trips/{id}" "GET /api/trips/{id}/impact"
  "PATCH /api/trips/{id}/status" "POST /api/trips/generate"
  "GET /api/internal/cron/generate"
  "GET /api/internal/events" "POST /api/internal/events/ack"
  "OPTIONS /{proxy+}"
)

EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" \
  --query "Items[].RouteKey" --output text 2>/dev/null || echo "")

for route in "${ROUTES[@]}"; do
  case " $EXISTING " in
    *" $route "*) continue ;;
  esac
  try aws apigatewayv2 create-route --api-id "$API_ID" \
    --route-key "$route" --target "integrations/${INTEGRATION_ID}" || true
done
echo "    ${#ROUTES[@]} routes"

# $default stage, auto-deployed, with throttling. Floci records these
# numbers but does not enforce them, which is exactly why the application
# also keeps its own limit in middleware/rateLimit.js.
if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  try aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' \
    --auto-deploy \
    --default-route-settings 'ThrottlingRateLimit=10,ThrottlingBurstLimit=20' || true
else
  try aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
    --default-route-settings 'ThrottlingRateLimit=10,ThrottlingBurstLimit=20' || true
fi
echo "    throttling 10 rps, burst 20"

# Who may invoke the function. Separate from the role, which says what the
# function may do. Real AWS checks both.
try aws lambda add-permission --function-name "$API_FN" \
  --statement-id apigw-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*" || true

API_URL="http://${API_ID}.execute-api.localhost.floci.io:4566"

# -----------------------------------------------------------------------------
say "8/9  EventBridge: weekly trip generation, and the event forwarder"

# The forwarder calls OUR API Gateway address, not Vercel.
if [ -f infra/aws/event-forwarder/index.mjs ]; then
  # Packaged with a small pure-Node zip writer, so no `zip` command is
  # needed and a space in the folder name cannot break anything.
  node -e '
    const fs = require("fs"), path = require("path"), zlib = require("zlib");
    const src = path.join("infra","aws","event-forwarder","index.mjs");
    const data = fs.readFileSync(src);
    const name = Buffer.from("index.mjs");
    const table = (()=>{const t=new Int32Array(256);for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[i]=c;}return t;})();
    let crc=-1; for (const b of data) crc=(crc>>>8)^table[(crc^b)&0xff]; crc=(crc^-1)>>>0;
    const comp = zlib.deflateRawSync(data,{level:9});
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(8,8);
    lh.writeUInt16LE(0x21,12); lh.writeUInt32LE(crc,14); lh.writeUInt32LE(comp.length,18); lh.writeUInt32LE(data.length,22); lh.writeUInt16LE(name.length,26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6); cd.writeUInt16LE(8,10);
    cd.writeUInt16LE(0x21,14); cd.writeUInt32LE(crc,16); cd.writeUInt32LE(comp.length,20); cd.writeUInt32LE(data.length,24); cd.writeUInt16LE(name.length,28);
    const off = lh.length+name.length+comp.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(46+name.length,12); end.writeUInt32LE(off,16);
    fs.mkdirSync("dist",{recursive:true});
    fs.writeFileSync(path.join("dist","forwarder.zip"), Buffer.concat([lh,name,comp,cd,name,end]));
  '

  FORWARDER_ENV="Variables={ROUTE_STOP_API_URL=${API_URL},EVENTS_TOPIC_ARN=${TOPIC_ARN},SECRET_ID=${SECRET}}"
  if aws lambda get-function --function-name "$FORWARDER_FN" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FORWARDER_FN" \
      --zip-file fileb://dist/forwarder.zip >/dev/null
    sleep 2
    aws lambda update-function-configuration --function-name "$FORWARDER_FN" \
      --environment "$FORWARDER_ENV" >/dev/null
    echo "    updated $FORWARDER_FN"
  else
    aws lambda create-function --function-name "$FORWARDER_FN" \
      --runtime nodejs20.x --handler index.handler \
      --role "$ROLE_ARN" --zip-file fileb://dist/forwarder.zip \
      --timeout 30 --environment "$FORWARDER_ENV" >/dev/null
    echo "    created $FORWARDER_FN"
  fi

  # Every five minutes: drain the outbox to SNS.
  aws events put-rule --name "${PREFIX}-drain-outbox" \
    --schedule-expression "rate(5 minutes)" >/dev/null
  try aws lambda add-permission --function-name "$FORWARDER_FN" \
    --statement-id events-invoke-forwarder --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT}:rule/${PREFIX}-drain-outbox" || true
  aws events put-targets --rule "${PREFIX}-drain-outbox" \
    --targets "Id=1,Arn=arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FORWARDER_FN}" >/dev/null
  echo "    rule ${PREFIX}-drain-outbox every 5 minutes"
fi

# Weekly generation, replacing Vercel Cron. EventBridge cannot call an HTTP
# address on Floci, so it invokes the API function with an event shaped like
# an API Gateway GET, which the same handler already understands.
aws events put-rule --name "${PREFIX}-generate-trips" \
  --schedule-expression "cron(0 2 ? * SUN *)" >/dev/null

GEN_EVENT=$(node -e '
  console.log(JSON.stringify(JSON.stringify({
    version: "2.0",
    routeKey: "GET /api/internal/cron/generate",
    rawPath: "/api/internal/cron/generate",
    rawQueryString: "days=21",
    queryStringParameters: { days: "21" },
    headers: { "x-internal-key": process.env.INTERNAL_API_KEY || "" },
    requestContext: { http: { method: "GET", path: "/api/internal/cron/generate", sourceIp: "127.0.0.1" } },
    isBase64Encoded: false
  })));
')

try aws lambda add-permission --function-name "$API_FN" \
  --statement-id events-invoke-generate --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT}:rule/${PREFIX}-generate-trips" || true

aws events put-targets --rule "${PREFIX}-generate-trips" \
  --targets "Id=1,Arn=arn:aws:lambda:${REGION}:${ACCOUNT}:function:${API_FN},Input=${GEN_EVENT}" >/dev/null
echo "    rule ${PREFIX}-generate-trips every Sunday 02:00"

# -----------------------------------------------------------------------------
say "9/9  CloudWatch: logs, a SECURITY metric filter, and an alarm"

try aws logs create-log-group --log-group-name "$LOG_GROUP" || true
try aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 14 || true

# middleware/logger.js writes {"event":"SECURITY", ...} for every refused
# request. This counts them, so a burst of 401s or 403s becomes a number on
# a graph instead of a line nobody reads.
try aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name "${PREFIX}-security-events" \
  --filter-pattern '{ $.event = "SECURITY" }' \
  --metric-transformations \
    "metricName=RouteStopSecurityEvents,metricNamespace=SchoolBus/RouteStop,metricValue=1,defaultValue=0" \
  || echo "    (Floci may not implement metric filters; real AWS does)"

try aws cloudwatch put-metric-alarm \
  --alarm-name "${PREFIX}-security-burst" \
  --alarm-description "More than 20 refused requests in 5 minutes" \
  --namespace "SchoolBus/RouteStop" --metric-name RouteStopSecurityEvents \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 20 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  || echo "    (Floci may not implement alarms; real AWS does)"
echo "    metric filter and alarm requested"

# -----------------------------------------------------------------------------
say "Done"

cat <<INFO

  API address   ${API_URL}
  Health        ${API_URL}/api/health
  Readiness     ${API_URL}/api/ready

  SNS topic     ${TOPIC_ARN}
  Secret        ${SECRET}  (KMS ${KEY_ALIAS})
  Logs          aws logs tail ${LOG_GROUP} --since 10m --format short

  Next:
    1. Put this address in the frontend .env.local as VITE_ROUTE_API_URL
       (that file is not committed).
    2. Ali runs his deploy.sh now, so his queue subscribes to the topic above.
    3. Cancel a trip and check his Alerts page.

INFO

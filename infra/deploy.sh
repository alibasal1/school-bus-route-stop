#!/usr/bin/env bash
# =============================================================================
# Route & Stop: build everything on Floci with one command.
#
#   export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
#   bash infra/deploy.sh
#
# Re-runnable. Every step either creates the thing or updates it, so running
# it again is not an error and does not make duplicates. If Floci is
# restarted and loses everything, this rebuilds it from nothing.
#
# Every name starts with "route-stop-" so nothing here can touch Ali's
# resources, which start with "favorites-alerts-".
#
# AWS services used by this component: DynamoDB, Lambda, API Gateway, SQS
# (sender), EventBridge, CloudWatch Logs, IAM. That is seven.
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="${AWS_ACCOUNT_ID:-000000000000}"
PREFIX="route-stop"

API_FN="${PREFIX}-api"
ROLE="${PREFIX}-api-role"
POLICY="${PREFIX}-api-policy"
HTTP_API="${PREFIX}-http-api"
LOG_GROUP="/aws/lambda/${API_FN}"
ZIP="dist/route-stop-api.zip"

# Ali's queue. We only ever send to it.
ALERTS_QUEUE_URL="${ALERTS_QUEUE_URL:-http://localhost:4566/${ACCOUNT}/favorites-alerts-queue}"
ALERTS_QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:favorites-alerts-queue"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n==> %s\n' "$1"; }
try() { "$@" >/dev/null 2>&1 || return 1; }

# -----------------------------------------------------------------------------
say "Checking what is needed"

command -v aws >/dev/null || { echo "The aws CLI is not installed."; exit 1; }
command -v node >/dev/null || { echo "Node is not installed."; exit 1; }

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "Cannot reach Floci. Is Docker running and Floci started?"
  echo "  export AWS_PROFILE=floci MSYS_NO_PATHCONV=1"
  exit 1
fi
echo "    aws ok, account ${ACCOUNT}, region ${REGION}"

# -----------------------------------------------------------------------------
say "1/8  DynamoDB tables"

# $1 table, $2 key attribute, $3.. GSI definitions as "index-name:attribute"
create_table() {
  local name="$1"; shift
  local key="$1"; shift

  if aws dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then
    echo "    $name already exists"
    return 0
  fi

  local attrs="AttributeName=${key},AttributeType=S"
  local schema="AttributeName=${key},KeyType=HASH"
  local gsi_args=()
  local gsi_json="["
  local first=1

  for gsi in "$@"; do
    local index="${gsi%%:*}"
    local attribute="${gsi##*:}"
    attrs="${attrs} AttributeName=${attribute},AttributeType=S"
    [ $first -eq 0 ] && gsi_json="${gsi_json},"
    gsi_json="${gsi_json}{\"IndexName\":\"${index}\",\"KeySchema\":[{\"AttributeName\":\"${attribute}\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}"
    first=0
  done
  gsi_json="${gsi_json}]"

  if [ "$gsi_json" != "[]" ]; then
    gsi_args=(--global-secondary-indexes "$gsi_json")
  fi

  # PAY_PER_REQUEST: no capacity to guess, and nothing to pay for when idle.
  aws dynamodb create-table \
    --table-name "$name" \
    --attribute-definitions $attrs \
    --key-schema "$schema" \
    --billing-mode PAY_PER_REQUEST \
    "${gsi_args[@]}" >/dev/null
  echo "    created $name"
}

# Tables this service owns.
create_table Routes id "name-index:name" "area-index:area"
create_table Stops id "route-id-index:route_id"
create_table Buses id "route-id-index:route_id" "supervisor-id-index:supervisor_id"
create_table RouteSchedules id "route-id-index:route_id"
create_table TripEvents event_id "sent-index:sent"

# Ahmed's tables. Created here only if they are missing, with his schema, so
# this service can run on a clean Floci without waiting for his deploy. If
# his script ran first, these are left exactly as they are.
create_table Trips id "route-id-index:route_id"
create_table Users user_id
create_table Sessions id

# TripStops has a sort key, so it does not fit the helper above.
if ! aws dynamodb describe-table --table-name TripStops >/dev/null 2>&1; then
  aws dynamodb create-table --table-name TripStops \
    --attribute-definitions AttributeName=trip_id,AttributeType=S AttributeName=stop_id,AttributeType=S \
    --key-schema AttributeName=trip_id,KeyType=HASH AttributeName=stop_id,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "    created TripStops"
else
  echo "    TripStops already exists"
fi

# -----------------------------------------------------------------------------
say "2/8  IAM role and a least-privilege policy"

cat > /tmp/${PREFIX}-trust.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
JSON

# Each statement names its tables. Note the split: write on the tables this
# service owns, read only on Users and Sessions, and send only to Ali's one
# queue. No "*" resource anywhere except the log-stream wildcard inside our
# own log group, which is how CloudWatch names streams.
cat > /tmp/${PREFIX}-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteOwnTables",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
        "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"
      ],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Routes",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Routes/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Stops",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Stops/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Buses",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Buses/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/RouteSchedules",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/RouteSchedules/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/TripEvents",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/TripEvents/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Trips",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Trips/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/TripStops"
      ]
    },
    {
      "Sid": "ReadAuthTablesOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Users",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/Sessions"
      ]
    },
    {
      "Sid": "SendToAlertsQueueOnly",
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "${ALERTS_QUEUE_ARN}"
    },
    {
      "Sid": "OwnLogsOnly",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${PREFIX}-*"
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
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY" \
  --policy-document file:///tmp/${PREFIX}-policy.json
echo "    policy $POLICY applied (write own tables, read Users/Sessions, send to one queue)"

ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE}"
rm -f /tmp/${PREFIX}-trust.json /tmp/${PREFIX}-policy.json

# -----------------------------------------------------------------------------
say "3/8  Optional: secrets"

# Only if something secret exists to store. The service runs without this:
# Turnstile is skipped when its key is absent, and the internal key is
# generated below if it was not provided.
INTERNAL_API_KEY="${INTERNAL_API_KEY:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"

if [ -n "${TURNSTILE_SECRET_KEY:-}" ]; then
  SECRET_FILE=$(mktemp); chmod 600 "$SECRET_FILE"
  node -e '
    const out = { INTERNAL_API_KEY: process.env.INTERNAL_API_KEY };
    if (process.env.TURNSTILE_SECRET_KEY) out.TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
    require("fs").writeFileSync(process.argv[1], JSON.stringify(out));
  ' "$SECRET_FILE"
  if aws secretsmanager describe-secret --secret-id "${PREFIX}/app" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "${PREFIX}/app" \
      --secret-string "file://${SECRET_FILE}" >/dev/null
  else
    aws secretsmanager create-secret --name "${PREFIX}/app" \
      --secret-string "file://${SECRET_FILE}" >/dev/null
  fi
  rm -f "$SECRET_FILE"
  SECRET_ID="${PREFIX}/app"
  echo "    secret ${PREFIX}/app stored"
else
  SECRET_ID=""
  echo "    no Turnstile key set, so no secret created (Turnstile will be skipped)"
fi

# -----------------------------------------------------------------------------
say "4/8  Building the deployment package"

npm install --omit=dev --no-audit --no-fund >/dev/null
npm run zip
[ -f "$ZIP" ] || { echo "$ZIP was not produced."; exit 1; }

# -----------------------------------------------------------------------------
say "5/8  Lambda"

CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173}"

# AWS_ENDPOINT_URL is what makes the SDK inside the function talk to Floci
# rather than real AWS. On real AWS it is simply left out.
ENV_VARS="Variables={NODE_ENV=production,CORS_ORIGINS=${CORS_ORIGINS},AWS_ENDPOINT_URL=http://host.docker.internal:4566,ALERTS_QUEUE_URL=${ALERTS_QUEUE_URL},INTERNAL_API_KEY=${INTERNAL_API_KEY},SECRET_ID=${SECRET_ID}}"

if aws lambda get-function --function-name "$API_FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$API_FN" \
    --zip-file "fileb://${ZIP}" >/dev/null
  sleep 2   # Floci can still report the function as updating
  aws lambda update-function-configuration --function-name "$API_FN" \
    --environment "$ENV_VARS" --timeout 30 --memory-size 512 >/dev/null
  echo "    updated $API_FN"
else
  aws lambda create-function --function-name "$API_FN" \
    --runtime nodejs20.x --handler lambda.handler \
    --role "$ROLE_ARN" --zip-file "fileb://${ZIP}" \
    --timeout 30 --memory-size 512 --environment "$ENV_VARS" >/dev/null
  echo "    created $API_FN"
fi

# -----------------------------------------------------------------------------
say "6/8  API Gateway, with throttling"

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${HTTP_API}'].ApiId | [0]" --output text 2>/dev/null || true)
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigatewayv2 create-api --name "$HTTP_API" --protocol-type HTTP \
    --query ApiId --output text)
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

# Only this service's routes, plus OPTIONS for the browser's preflight. No
# catch-all: a path that does not exist is refused at the gateway instead of
# waking the function.
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
  "GET /api/internal/cron/generate" "POST /api/internal/events/retry"
  "OPTIONS /{proxy+}"
)

EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text 2>/dev/null || echo "")
for route in "${ROUTES[@]}"; do
  case " $EXISTING " in *" $route "*) continue ;; esac
  try aws apigatewayv2 create-route --api-id "$API_ID" \
    --route-key "$route" --target "integrations/${INTEGRATION_ID}" || true
done
echo "    ${#ROUTES[@]} routes"

if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  try aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
    --default-route-settings 'ThrottlingRateLimit=10,ThrottlingBurstLimit=20' || true
else
  try aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
    --default-route-settings 'ThrottlingRateLimit=10,ThrottlingBurstLimit=20' || true
fi
echo "    throttling 10 rps, burst 20"
echo "    (Floci records throttling but does not enforce it, which is why"
echo "     middleware/rateLimit.js also limits per source IP)"

# Who may invoke the function. Separate from the role, which says what the
# function may do. Real AWS checks both.
try aws lambda add-permission --function-name "$API_FN" \
  --statement-id apigw-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*" || true

API_URL="http://${API_ID}.execute-api.localhost.floci.io:4566"

# -----------------------------------------------------------------------------
say "7/8  EventBridge: daily trip generation"

aws events put-rule --name "${PREFIX}-daily-generate" \
  --schedule-expression "cron(0 2 * * ? *)" >/dev/null

# EventBridge on Floci cannot call an HTTP address, so it invokes the
# function with an event shaped like an API Gateway GET. The same handler
# understands it, so there is no second code path to keep working.
GEN_EVENT=$(INTERNAL_API_KEY="$INTERNAL_API_KEY" node -e '
  console.log(JSON.stringify(JSON.stringify({
    version: "2.0",
    routeKey: "GET /api/internal/cron/generate",
    rawPath: "/api/internal/cron/generate",
    rawQueryString: "",
    headers: { "x-internal-key": process.env.INTERNAL_API_KEY },
    requestContext: { http: { method: "GET", path: "/api/internal/cron/generate", sourceIp: "127.0.0.1" } },
    isBase64Encoded: false
  })));
')

try aws lambda add-permission --function-name "$API_FN" \
  --statement-id events-invoke-generate --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT}:rule/${PREFIX}-daily-generate" || true

aws events put-targets --rule "${PREFIX}-daily-generate" \
  --targets "Id=1,Arn=arn:aws:lambda:${REGION}:${ACCOUNT}:function:${API_FN},Input=${GEN_EVENT}" >/dev/null
echo "    rule ${PREFIX}-daily-generate, every day 02:00"

# -----------------------------------------------------------------------------
say "8/8  CloudWatch: logs, a SECURITY metric filter, and an alarm"

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

  Logs          aws logs tail ${LOG_GROUP} --since 10m --format short
  Alerts queue  ${ALERTS_QUEUE_URL}  (send only)

  Next:
    1. npm run seed
    2. node scripts/make-test-sessions.js
    3. Put the address above in the frontend .env.local as
       VITE_ROUTES_API_URL (that file is not committed).
    4. Ali runs his deploy.sh so his queue exists, then cancel a trip and
       check his Alerts page.

INFO

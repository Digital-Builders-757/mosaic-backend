#!/usr/bin/env bash
set -euo pipefail

HTTP_TIMEOUT_SECONDS="${RELEASE_HTTP_TIMEOUT_SECONDS:-15}"
CURL_BIN="${CURL_BIN:-curl}"
EXPECTED_STATE="active"
INHERITED_RELEASE_MODE="${RELEASE_MODE-}"
INHERITED_RELEASE_MODE_SET=false
if [ "${RELEASE_MODE+x}" = x ]; then
  INHERITED_RELEASE_MODE_SET=true
fi
EXPLICIT_RELEASE_MODE=""
RELEASE_MODE_FLAG_SET=false

# Reject duplicates across the entire invocation before any URL can be probed.
RELEASE_MODE_FLAG_SEEN=false
for argument in "$@"; do
  if [ "$argument" = "--release-mode" ]; then
    if [ "$RELEASE_MODE_FLAG_SEEN" = true ]; then
      echo "Duplicate option: --release-mode" >&2
      exit 2
    fi
    RELEASE_MODE_FLAG_SEEN=true
  fi
done

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state|--release-mode)
      if [ "$#" -lt 2 ]; then
        echo "$1 requires a value" >&2
        exit 2
      fi
      if [ "$1" = "--state" ]; then
        EXPECTED_STATE="$2"
      else
        EXPLICIT_RELEASE_MODE="$2"
        RELEASE_MODE_FLAG_SET=true
      fi
      shift 2
      ;;
    --*)
      echo "Unsupported option: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [ "$RELEASE_MODE_FLAG_SET" = true ] \
  && [ "$INHERITED_RELEASE_MODE_SET" = true ] \
  && [ "$EXPLICIT_RELEASE_MODE" != "$INHERITED_RELEASE_MODE" ]; then
  echo "--release-mode disagrees with inherited RELEASE_MODE" >&2
  exit 2
fi
if [ "$RELEASE_MODE_FLAG_SET" = true ]; then
  RELEASE_MODE="$EXPLICIT_RELEASE_MODE"
elif [ "$INHERITED_RELEASE_MODE_SET" = true ]; then
  RELEASE_MODE="$INHERITED_RELEASE_MODE"
else
  RELEASE_MODE="release"
fi

if [ "$EXPECTED_STATE" != "active" ] && [ "$EXPECTED_STATE" != "inactive" ]; then
  echo "--state must be active or inactive" >&2
  exit 2
fi
if [ "$RELEASE_MODE" != "release" ] && [ "$RELEASE_MODE" != "focused-baseline" ] \
  && [ "$RELEASE_MODE" != "rollback" ] \
  && [ "$RELEASE_MODE" != "legacy-retirement-bootstrap" ]; then
  echo "--release-mode must be release, rollback, focused-baseline, or legacy-retirement-bootstrap" >&2
  exit 2
fi
# Break-glass rollback uses the canonical (release) gate path whether the mode
# is inherited from RELEASE_MODE or passed explicitly with --release-mode, which
# is what the production workflow does. The flag/environment agreement check
# above still applies, so this cannot downgrade a focused-baseline gate.
if [ "$RELEASE_MODE" = "rollback" ]; then
  RELEASE_MODE="release"
fi

if [ "$#" -eq 0 ] && [ -n "${PRODUCTION_API_URL:-}" ]; then
  set -- "$PRODUCTION_API_URL"
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: verify-checkout-gate.sh [--state active|inactive] [--release-mode release|rollback|focused-baseline|legacy-retirement-bootstrap] BASE_URL [BASE_URL ...]" >&2
  exit 2
fi

request_status() {
  local method="$1"
  local path="$2"
  local base_url="$3"
  local status
  local -a args=(
    --silent
    --show-error
    --output /dev/null
    --write-out "%{http_code}"
    --max-time "$HTTP_TIMEOUT_SECONDS"
    --request "$method"
  )

  if [ "$method" = "POST" ]; then
    args+=(
      --header "Content-Type: application/json"
      --header "stripe-signature: t=0,v1=invalid-release-preflight"
      --data-binary "{}"
    )
  fi

  if ! status=$("$CURL_BIN" "${args[@]}" "${base_url}${path}"); then
    echo "Request failed for $method $path" >&2
    return 1
  fi

  printf '%s' "$status"
}

webhook_paths=(
  "/api/webhooks/stripe"
  "/api/stripe/webhook"
  "/api/stripe/payment/webhook"
  "/api/subscription/webhook"
  "/api/vendor-onboarding/webhook/payment"
)

health_paths=(
  "/api/health"
  "/api/ready"
  "/api/build-info"
)

# These are the application-equivalent spellings accepted by Express's
# default non-strict, case-insensitive router. The ALB gate must cover all of
# them or an authenticated checkout can bypass the controlled cutover.
checkout_paths=(
  "/api/orders/initiate"
  "/api/orders/initiate/"
  "/API/ORDERS/INITIATE"
  "/Api/Orders/Initiate/"
)
legacy_payment_paths=(
  "/api/payments/create-payment-intent"
  "/api/payments/create-payment-intent/"
  "/API/PAYMENTS/CREATE-PAYMENT-INTENT"
  "/Api/Payments/Create-Payment-Intent/"
)
if [ "$RELEASE_MODE" = "focused-baseline" ]; then
  checkout_paths+=("${legacy_payment_paths[@]}")
fi
# The legacy-retirement bootstrap deploys over a live build that still mounts
# the legacy route: while gated, both initiators must answer the ALB 503; once
# ungated, the retired build must answer 404/405 (never the old 401).
retirement_bootstrap=false
if [ "$RELEASE_MODE" = "legacy-retirement-bootstrap" ]; then
  retirement_bootstrap=true
fi

surface_number=0
for candidate_base_url in "$@"; do
  surface_number=$((surface_number + 1))
  if [[ ! "$candidate_base_url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
    echo "Every BASE_URL must be an origin URL without credentials, path, query, or fragment" >&2
    exit 2
  fi
  BASE_URL="${candidate_base_url%/}"
  echo "Release surface $surface_number"

  for path in "${checkout_paths[@]}"; do
    initiate_status=$(request_status POST "$path" "$BASE_URL")
    echo "POST $path: HTTP $initiate_status"
    if [ "$EXPECTED_STATE" = "active" ] && [ "$initiate_status" != "503" ]; then
      echo "Checkout gate verification failed: expected infrastructure maintenance HTTP 503 for every application-equivalent checkout path" >&2
      exit 1
    fi
    if [ "$EXPECTED_STATE" = "inactive" ] && [ "$initiate_status" != "401" ]; then
      echo "Checkout ungated verification failed: expected normal unauthenticated HTTP 401 for every application-equivalent checkout path" >&2
      exit 1
    fi
  done

  if [ "$retirement_bootstrap" = true ]; then
    for path in "${legacy_payment_paths[@]}"; do
      legacy_status=$(request_status POST "$path" "$BASE_URL")
      echo "POST $path: HTTP $legacy_status"
      if [ "$EXPECTED_STATE" = "active" ] && [ "$legacy_status" != "503" ]; then
        echo "Checkout gate verification failed: expected infrastructure maintenance HTTP 503 for every legacy payment-intent path during retirement bootstrap" >&2
        exit 1
      fi
      if [ "$EXPECTED_STATE" = "inactive" ] && [ "$legacy_status" != "404" ] && [ "$legacy_status" != "405" ]; then
        echo "Legacy retirement verification failed: expected retired HTTP 404 or 405 for every legacy payment-intent path" >&2
        exit 1
      fi
    done
  fi

  for path in "${webhook_paths[@]}"; do
    status=$(request_status POST "$path" "$BASE_URL")
    echo "POST $path (invalid signature): HTTP $status"
    if [ "$status" = "503" ]; then
      echo "Webhook reachability failed: checkout maintenance gate also blocks $path" >&2
      exit 1
    fi
    if [ "$status" != "400" ]; then
      echo "Webhook reachability failed: expected application signature rejection HTTP 400 for $path" >&2
      exit 1
    fi
  done

  for path in "${health_paths[@]}"; do
    status=$(request_status GET "$path" "$BASE_URL")
    echo "GET $path: HTTP $status"
    if [ "$status" != "200" ]; then
      echo "Health surface verification failed: expected HTTP 200 for $path" >&2
      exit 1
    fi
  done
done

if [ "$EXPECTED_STATE" = "active" ]; then
  echo "Checkout gate is active on every release surface; Stripe webhooks and health surfaces remain reachable."
else
  echo "Checkout gate is inactive on every release surface; normal auth, Stripe webhooks, and health surfaces are verified."
fi

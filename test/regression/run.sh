#!/usr/bin/env bash
# Regression suite: build the fixture app with the adapter, run the compiled
# binary, assert serving behavior over real HTTP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$ROOT/test/regression/fixture"
PORT="${PORT:-8973}"
PASS=0
FAIL=0
SERVER_PID=""

cleanup() {
  [[ -n $SERVER_PID ]] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

check() { # check <name> <actual> <expected-substring>
  local name=$1 actual=$2 expected=$3
  if [[ $actual == *"$expected"* ]]; then
    echo "  ok: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    expected substring: $expected"
    echo "    actual: ${actual:0:300}"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> Building adapter package"
(cd "$ROOT" && bun run build)

echo "==> Installing fixture deps (fresh copy of file: dependency)"
(cd "$FIXTURE" && rm -rf node_modules bun.lock dist .svelte-kit && bun install)

echo "==> Building fixture app (bun --bun so the adapter can compile)"
(cd "$FIXTURE" && bun --bun run build)

[[ -f "$FIXTURE/dist/app" ]] || { echo "FAIL: no binary at dist/app"; exit 1; }
echo "  ok: binary produced ($(du -h "$FIXTURE/dist/app" | cut -f1))"
PASS=$((PASS + 1))

echo "==> Starting compiled binary on :$PORT"
PORT=$PORT HOST=127.0.0.1 "$FIXTURE/dist/app" &
SERVER_PID=$!
for i in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null && break
  sleep 0.1
  [[ $i == 50 ]] && { echo "FAIL: server never became ready"; exit 1; }
done

BASE="http://127.0.0.1:$PORT"

# 1. Dynamic SSR route
check "SSR home renders" "$(curl -fsS "$BASE/")" "home-ssr-marker"

# 2. SSR is actually dynamic (timestamp changes between requests)
A=$(curl -fsS "$BASE/" | grep -o 'rendered at [0-9]*')
sleep 0.05
B=$(curl -fsS "$BASE/" | grep -o 'rendered at [0-9]*')
if [[ $A != "$B" ]]; then
  echo "  ok: home is dynamic (fresh render per request)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: home looks cached/prerendered ($A == $B)"
  FAIL=$((FAIL + 1))
fi

# 3. Prerendered page served (pretty URL alias)
check "prerendered /about" "$(curl -fsS "$BASE/about")" "about-prerendered-marker"

# 4. Prerendered file path also serves
check "prerendered /about.html" "$(curl -fsS "$BASE/about.html")" "about-prerendered-marker"

# 5. ETag + conditional request → 304
ETAG=$(curl -fsSI "$BASE/about" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
if [[ -n $ETAG ]]; then
  echo "  ok: ETag present on prerendered page"
  PASS=$((PASS + 1))
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$BASE/about")
  check "If-None-Match → 304" "$CODE" "304"
else
  echo "  FAIL: no ETag on /about"
  FAIL=$((FAIL + 1))
fi

# 6. Static asset from /static
check "static robots.txt" "$(curl -fsS "$BASE/robots.txt")" "User-agent"

# 7. Immutable client asset gets immutable cache-control
ASSET=$(curl -fsS "$BASE/" | grep -o '/_app/immutable/[^"]*\.js' | head -1)
if [[ -n $ASSET ]]; then
  CC=$(curl -fsSI "$BASE$ASSET" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
  check "immutable cache-control" "$CC" "immutable"
else
  echo "  FAIL: no immutable asset URL found in home HTML"
  FAIL=$((FAIL + 1))
fi

# 8. API endpoint (dynamic +server.js)
check "api health endpoint" "$(curl -fsS "$BASE/api/health")" '"ok":true'

# 9. Prerendered redirect
LOC=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/legacy")
check "prerendered 308 redirect" "$LOC" "308"
check "redirect location → /about" "$LOC" "/about"

# 10. 404 for unknown routes
check "unknown route 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/definitely-not-a-page")" "404"

# 11. Graceful shutdown on SIGTERM
kill -TERM "$SERVER_PID"
for i in $(seq 1 50); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "  FAIL: server still running 5s after SIGTERM"
  FAIL=$((FAIL + 1))
else
  echo "  ok: graceful shutdown on SIGTERM"
  PASS=$((PASS + 1))
  SERVER_PID=""
fi

echo
echo "==> $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

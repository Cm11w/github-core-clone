#!/usr/bin/env bash
# End-to-end verification for the forge: boots a real server, then exercises it
# with the real git CLI plus curl over REST, GraphQL and MCP. Exits 0 only when
# every check passes. Requires: node, git, curl, jq (jq only for pretty output).
#
#   bash tests/e2e.sh
#
# The server under test runs on 127.0.0.1:18799 with a throwaway token; nothing
# here touches the network beyond localhost, and all scratch lives in mktemp dirs.

set -u
cd "$(dirname "$0")/.."

PORT=18799
TOKEN="e2e-token-$$"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
GITENV=(env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  GIT_AUTHOR_NAME="Ada Iversen" GIT_AUTHOR_EMAIL="ada@example.com"
  GIT_COMMITTER_NAME="Ada Iversen" GIT_COMMITTER_EMAIL="ada@example.com")
FAIL=0

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAIL=1; }
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
}

# --- boot -------------------------------------------------------------------
WORK="$(mktemp -d)"
MAKEFUN_SHOP_TOKEN="$TOKEN" PORT="$PORT" node --experimental-strip-types main.ts \
  >"${TMPDIR:-/tmp}/forge-e2e.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do
  curl -fsS -m 2 "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done
check "healthz answers" curl -fsS -m 2 "$BASE/healthz"
check "healthz needs no token" curl -fsS -m 2 "$BASE/healthz"

AUTH_HEADER="http.extraHeader=$AUTH"

# --- REST -------------------------------------------------------------------
REST() { curl -s -m 10 -H "$AUTH" -H "Content-Type: application/json" "$@"; }
CODE=$(REST -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v3/user/repos" \
  -d '{"name":"e2e","description":"end to end","private":true}')
[ "$CODE" = "201" ] && pass "REST create repo 201" || fail "REST create repo 201 (got $CODE)"
CODE=$(REST -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v3/user/repos" -d '{"name":"e2e"}')
[ "$CODE" = "422" ] && pass "REST duplicate repo 422" || fail "REST duplicate repo 422 (got $CODE)"
BODY=$(REST "$BASE/api/v3/user")
echo "$BODY" | grep -q '"login":"adaiversen"' && pass "REST viewer login" || fail "REST viewer login"
BODY=$(REST -X PUT "$BASE/api/v3/repos/adaiversen/e2e/contents/hello.txt" \
  -d '{"message":"hello","content":"aGVsbG8gZWFydGgK"}')
SHA=$(echo "$BODY" | sed -n 's/.*"sha":"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)
[ -n "$SHA" ] && pass "REST contents PUT returns blob sha" || fail "REST contents PUT sha"
BODY=$(REST "$BASE/api/v3/repos/adaiversen/e2e/contents/hello.txt")
echo "$BODY" | grep -q 'aGVsbG8gZWFydGgK' && pass "REST contents GET decodes" || fail "REST contents GET"
CODE=$(REST -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/v3/repos/adaiversen/e2e/contents/hello.txt" \
  -d '{"message":"stale","content":"eA==","sha":"0000000000000000000000000000000000000000"}')
[ "$CODE" = "409" ] && pass "REST stale sha 409" || fail "REST stale sha 409 (got $CODE)"
CODE=$(REST -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v3/repos/adaiversen/e2e/issues" \
  -d '{"title":"bad label","labels":["no-such-label"]}')
[ "$CODE" = "422" ] && pass "REST unknown label 422" || fail "REST unknown label 422 (got $CODE)"
REST -X POST "$BASE/api/v3/repos/adaiversen/e2e/labels" -d '{"name":"bug","color":"ff0000"}' >/dev/null
BODY=$(REST -X POST "$BASE/api/v3/repos/adaiversen/e2e/issues" \
  -d '{"title":"first issue","body":"b","labels":["bug"]}')
echo "$BODY" | grep -q '"number":1' && pass "REST issue number 1" || fail "REST issue number 1"
CODE=$(REST -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v3/repos/adaiversen/e2e/issues/1/comments" \
  -d '{"body":"hello comment"}')
[ "$CODE" = "201" ] && pass "REST comment 201" || fail "REST comment 201 (got $CODE)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 -H "Authorization: Bearer wrong" "$BASE/api/v3/user")
[ "$CODE" = "401" ] && pass "REST wrong token 401" || fail "REST wrong token 401 (got $CODE)"
CODE=$(REST -o /dev/null -w "%{http_code}" "$BASE/api/v3/repos/adaiversen/nope")
[ "$CODE" = "404" ] && pass "REST missing repo 404" || fail "REST missing repo 404 (got $CODE)"

# --- git CLI: clone / push / fetch ------------------------------------------
"${GITENV[@]}" git clone -c "$AUTH_HEADER" "$BASE/adaiversen/e2e.git" "$WORK/w1" 2>/dev/null
check "git clone of REST-created repo" test -f "$WORK/w1/hello.txt"
( cd "$WORK/w1" && echo "more" >> hello.txt && "${GITENV[@]}" git commit -qam "second" \
  && "${GITENV[@]}" git -c "$AUTH_HEADER" push origin main 2>/dev/null )
check "git push second commit" test "$?" -eq 0
"${GITENV[@]}" git clone -c "$AUTH_HEADER" "$BASE/adaiversen/e2e.git" "$WORK/w2" 2>/dev/null
grep -q "more" "$WORK/w2/hello.txt" 2>/dev/null && pass "clone-back sees pushed commit" || fail "clone-back"
( cd "$WORK/w2" && "${GITENV[@]}" git tag -a v1 -m "release one" \
  && "${GITENV[@]}" git -c "$AUTH_HEADER" push origin v1 2>/dev/null )
check "annotated tag push" test "$?" -eq 0
"${GITENV[@]}" git clone -c "$AUTH_HEADER" --branch v1 "$BASE/adaiversen/e2e.git" "$WORK/w3" 2>/dev/null
check "clone tag v1" test -f "$WORK/w3/hello.txt"

# divergent push must be refused
( cd "$WORK/w1" && "${GITENV[@]}" git -c "$AUTH_HEADER" fetch origin 2>/dev/null \
  && "${GITENV[@]}" git reset -q --hard HEAD~1 && echo "diverged" > hello.txt \
  && "${GITENV[@]}" git commit -qam "diverged" )
if ( cd "$WORK/w1" && "${GITENV[@]}" git -c "$AUTH_HEADER" push origin main 2>&1 | grep -q "non-fast-forward" ); then
  pass "divergent push refused non-fast-forward"
else
  fail "divergent push refused"
fi

# --- git CLI: shallow / deepen / unshallow ----------------------------------
REST -X POST "$BASE/api/v3/user/repos" -d '{"name":"chain"}' >/dev/null
"${GITENV[@]}" git clone -c "$AUTH_HEADER" "$BASE/adaiversen/chain.git" "$WORK/chain" 2>/dev/null
( cd "$WORK/chain" && for i in $(seq 1 30); do echo "$i" > n.txt; "${GITENV[@]}" git add n.txt; "${GITENV[@]}" git commit -qm "c$i"; done \
  && "${GITENV[@]}" git -c "$AUTH_HEADER" push origin main 2>/dev/null )
check "30-commit chain pushed" test "$?" -eq 0
"${GITENV[@]}" git clone -c "$AUTH_HEADER" --depth 2 "$BASE/adaiversen/chain.git" "$WORK/shallow" 2>/dev/null
N=$(cd "$WORK/shallow" && git rev-list --count HEAD)
[ "$N" = "2" ] && pass "shallow depth 2 has 2 commits" || fail "shallow depth 2 (got $N)"
( cd "$WORK/shallow" && "${GITENV[@]}" git -c "$AUTH_HEADER" fetch --deepen=2 origin 2>/dev/null )
N=$(cd "$WORK/shallow" && git rev-list --count HEAD)
[ "$N" = "4" ] && pass "deepen 2 reaches 4 commits" || fail "deepen 2 (got $N)"
( cd "$WORK/shallow" && "${GITENV[@]}" git -c "$AUTH_HEADER" fetch --unshallow origin 2>/dev/null )
N=$(cd "$WORK/shallow" && git rev-list --count HEAD)
[ "$N" = "30" ] && pass "unshallow reaches 30 commits" || fail "unshallow (got $N)"

# --- git CLI: concurrent pushes ---------------------------------------------
REST -X POST "$BASE/api/v3/user/repos" -d '{"name":"race"}' >/dev/null
"${GITENV[@]}" git clone -c "$AUTH_HEADER" "$BASE/adaiversen/race.git" "$WORK/race" 2>/dev/null
( cd "$WORK/race" && echo base > f.txt && "${GITENV[@]}" git add f.txt && "${GITENV[@]}" git commit -qm base \
  && "${GITENV[@]}" git -c "$AUTH_HEADER" push origin main 2>/dev/null )
PUSH_PIDS=""
for b in b1 b2 b3 b4; do
  ( "${GITENV[@]}" git clone -q -c "$AUTH_HEADER" "$BASE/adaiversen/race.git" "$WORK/race-$b" 2>/dev/null \
    && cd "$WORK/race-$b" && "${GITENV[@]}" git checkout -qb "$b" main && echo "$b" > "$b.txt" \
    && "${GITENV[@]}" git add "$b.txt" && "${GITENV[@]}" git commit -qm "$b" \
    && "${GITENV[@]}" git -c "$AUTH_HEADER" push origin "$b" 2>/dev/null ) &
  PUSH_PIDS="$PUSH_PIDS $!"
done
wait $PUSH_PIDS
COUNT=$(REST "$BASE/api/v3/repos/adaiversen/race/branches" | grep -o '"name":"b[0-9]"' | grep -c .)
[ "$COUNT" = "4" ] && pass "4 concurrent branch pushes land" || fail "concurrent pushes (got $COUNT)"

# --- PR flow over REST -------------------------------------------------------
BODY=$(REST -X PUT "$BASE/api/v3/repos/adaiversen/e2e/contents/pr.txt" \
  -d '{"message":"pr work","content":"cHItd29yaw==","branch":"feature"}')
[ -n "$BODY" ] && pass "contents PUT creates feature branch" || fail "feature branch"
BODY=$(REST -X POST "$BASE/api/v3/repos/adaiversen/e2e/pulls" \
  -d '{"title":"add pr file","head":"feature","base":"main"}')
echo "$BODY" | grep -q '"number":2' && pass "REST PR number 2" || fail "REST PR number"
BODY=$(REST "$BASE/api/v3/repos/adaiversen/e2e/pulls/2/files")
echo "$BODY" | grep -q '"filename":"pr.txt"' && pass "REST PR files lists pr.txt" || fail "REST PR files"
BODY=$(REST -X PUT "$BASE/api/v3/repos/adaiversen/e2e/pulls/2/merge" -d '{"merge_method":"squash"}')
echo "$BODY" | grep -q '"merged":true' && pass "REST squash merge" || fail "REST squash merge"
BODY=$(REST "$BASE/api/v3/repos/adaiversen/e2e/contents/pr.txt")
echo "$BODY" | grep -q 'cHItd29yaw==' && pass "merged content on main" || fail "merged content"

# --- GraphQL -----------------------------------------------------------------
GQL() { REST -X POST "$BASE/api/graphql" -d "{\"query\":$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"; }
BODY=$(GQL '{ viewer { login } }')
echo "$BODY" | grep -q '"login":"adaiversen"' && pass "GraphQL viewer" || fail "GraphQL viewer"
BODY=$(GQL '{ repository(owner:"adaiversen", name:"e2e") { nameWithOwner defaultBranchRef { name } viewerPermission } }')
echo "$BODY" | grep -q '"nameWithOwner":"adaiversen/e2e"' && pass "GraphQL repository" || fail "GraphQL repository"
BODY=$(GQL '{ viewer { noSuchFieldOnViewer } }')
echo "$BODY" | grep -q 'noSuchFieldOnViewer' && echo "$BODY" | grep -q '"errors"' \
  && pass "GraphQL invalid field errors" || fail "GraphQL invalid field"
BODY=$(GQL '{ repository(owner:"adaiversen", name:"nope") { name } }')
echo "$BODY" | grep -q '"repository":null' && pass "GraphQL unknown repo null" || fail "GraphQL unknown repo"

# --- MCP ----------------------------------------------------------------------
MCP() { REST -X POST "$BASE/mcp" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
BODY=$(MCP "server/discover" '{}')
echo "$BODY" | grep -q '2026-07-28' && pass "MCP discover" || fail "MCP discover"
BODY=$(MCP "tools/list" '{}')
N=$(echo "$BODY" | grep -o '"name":"[a-z_]*"' | grep -c .)
[ "$N" = "10" ] && pass "MCP 10 tools listed" || fail "MCP tools count (got $N)"
BODY=$(MCP "tools/call" '{"name":"create_repo","arguments":{"name":"mcp-e2e"}}')
echo "$BODY" | grep -q '"full_name":"adaiversen/mcp-e2e"' && pass "MCP create_repo" || fail "MCP create_repo"
BODY=$(MCP "tools/call" '{"name":"nope","arguments":{}}')
echo "$BODY" | grep -q '"code":-32602' && pass "MCP unknown tool -32602" || fail "MCP unknown tool"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 -X POST "$BASE/mcp" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')
[ "$CODE" = "401" ] && pass "MCP no token 401" || fail "MCP no token 401 (got $CODE)"

# --- verdict ------------------------------------------------------------------
[ "$FAIL" = "0" ] && printf '\nE2E: ALL CHECKS PASS\n' || printf '\nE2E: FAILURES PRESENT\n'
exit "$FAIL"

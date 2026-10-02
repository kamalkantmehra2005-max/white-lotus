#!/usr/bin/env bash
# =====================================================================================================
#  WHITE-LOTUS security smoke test
#
#    ./scripts/smoke-security.sh https://YOUR-DOMAIN.com            # non-invasive checks (safe for production)
#    ./scripts/smoke-security.sh https://YOUR-DOMAIN.com --full     # + creates 2 throwaway accounts and tests
#                                                                   #   cross-user isolation, sessions, signed links,
#                                                                   #   brute-force lockout; deletes them afterwards
#    ./scripts/smoke-security.sh https://YOUR-DOMAIN.com --full --wait-expiry   # + waits for a signed link to expire
#
#  This is a SMOKE TEST: it catches common misconfigurations. It does not prove the application is secure.
#  Needs: bash, curl, grep, sed (and openssl for the certificate check).
# =====================================================================================================
set -uo pipefail
BASE="${1:-${BASE:-}}"
[ -z "$BASE" ] && { echo "Usage: $0 https://YOUR-DOMAIN.com [--full] [--wait-expiry]"; exit 2; }
BASE="${BASE%/}"
FULL=0; WAIT_EXPIRY=0
for a in "$@"; do [ "$a" = "--full" ] && FULL=1; [ "$a" = "--wait-expiry" ] && WAIT_EXPIRY=1; done
HOST=$(echo "$BASE" | sed -E 's#^https?://##; s#/.*##')
HTTPS=0; [[ "$BASE" == https://* ]] && HTTPS=1
PASS=0; FAIL=0; WARN=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
C=(curl -s --max-time 20)

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      ${2:0:300}"; FAIL=$((FAIL+1)); }
warn() { echo "  ! $1"; WARN=$((WARN+1)); }
has()  { echo "$2" | grep -qiE -- "$3" && ok "$1" || bad "$1" "$2"; }
hasnt(){ echo "$2" | grep -qiE -- "$3" && bad "$1" "$(echo "$2" | grep -iE -- "$3" | head -2)" || ok "$1"; }
code() { "${C[@]}" -o /dev/null -w '%{http_code}' "$@"; }

echo "WHITE-LOTUS security smoke test → $BASE"
[ $HTTPS -eq 0 ] && warn "Target is not https:// — transport checks will be skipped (fine for local testing only)."

# ---------------------------------------------------------------------------------------------------
echo; echo "1. Transport"
if [ $HTTPS -eq 1 ]; then
  if "${C[@]}" -o /dev/null "$BASE/api/health"; then ok "TLS handshake and certificate valid (curl verification)"; else bad "TLS/certificate problem (curl could not verify)"; fi
  if command -v openssl >/dev/null; then
    END=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [ -n "$END" ] && ok "certificate expires: $END" || warn "could not read certificate expiry"
  fi
  R=$("${C[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$HOST/")
  echo "$R" | grep -qE "^30[178] https://" && ok "HTTP → HTTPS redirect ($R)" || bad "HTTP is not redirected to HTTPS" "$R"
fi

# ---------------------------------------------------------------------------------------------------
echo; echo "2. Security headers"
H=$("${C[@]}" -D - -o "$TMP/home.html" "$BASE/")
HL=$("${C[@]}" -D - -o /dev/null "$BASE/login")
CSP=$(echo "$H" | grep -i '^content-security-policy:' | head -1)
has   "Content-Security-Policy present" "$CSP" "default-src 'self'"
has   "CSP uses a per-request nonce + strict-dynamic" "$CSP" "'nonce-[A-Za-z0-9+/=]+'.*'strict-dynamic'"
hasnt "CSP script-src has no unsafe-inline / unsafe-eval" "$(echo "$CSP" | grep -oiE "script-src[^;]*")" "unsafe-(inline|eval)"
has   "CSP forbids framing (frame-ancestors 'none')" "$CSP" "frame-ancestors 'none'"
has   "CSP blocks plugins (object-src 'none')" "$CSP" "object-src 'none'"
N1=$(echo "$CSP" | grep -oE "nonce-[A-Za-z0-9+/=]+"); N2=$("${C[@]}" -D - -o /dev/null "$BASE/" | grep -i '^content-security-policy:' | grep -oE "nonce-[A-Za-z0-9+/=]+")
[ -n "$N1" ] && [ "$N1" != "$N2" ] && ok "CSP nonce changes on every request" || bad "CSP nonce is missing or reused"
[ $HTTPS -eq 1 ] && has "Strict-Transport-Security (HSTS)" "$H" "strict-transport-security: max-age=[0-9]{7,}"
has   "X-Content-Type-Options: nosniff" "$H" "x-content-type-options: nosniff"
has   "X-Frame-Options: DENY" "$H" "x-frame-options: deny"
has   "Referrer-Policy" "$H" "referrer-policy: (strict-origin-when-cross-origin|no-referrer|same-origin)"
has   "Permissions-Policy" "$H" "permissions-policy:"
has   "Cross-Origin-Opener-Policy" "$H" "cross-origin-opener-policy: same-origin"
hasnt "No X-Powered-By header" "$H" "^x-powered-by"
has   "Login page carries the same headers" "$HL" "content-security-policy:.*nonce"

# ---------------------------------------------------------------------------------------------------
echo; echo "3. Cookies"
CK=$("${C[@]}" -D - -o /dev/null "$BASE/api/auth/csrf" | grep -i '^set-cookie:')
has "Auth cookies are HttpOnly" "$CK" "httponly"
has "Auth cookies are SameSite=Lax/Strict" "$CK" "samesite=(lax|strict)"
if [ $HTTPS -eq 1 ]; then
  has "Auth cookies are Secure" "$CK" "; secure"
  has "Auth cookies use __Host-/__Secure- prefixes" "$CK" "__(Host|Secure)-"
fi

# ---------------------------------------------------------------------------------------------------
echo; echo "4. Authentication required (anonymous requests)"
for p in /chat /settings /files /projects /admin; do
  R=$("${C[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE$p")
  echo "$R" | grep -qE "^30[27] .*/login" && ok "page $p → sign-in" || bad "page $p is reachable without signing in" "$R"
done
for p in /api/conversations /api/files /api/projects /api/memories /api/settings /api/settings/export /api/settings/sessions /api/usage /api/models /api/admin/stats /api/admin/users; do
  B=$("${C[@]}" -w ' %{http_code}' "$BASE$p")
  echo "$B" | grep -qE '"unauthorized".* 401$' && ok "API $p → 401" || bad "API $p did not return 401 JSON" "$B"
done
R=$(code -X POST -H "Origin: $BASE" "$BASE/api/files/00000000-0000-0000-0000-000000000000/link")
[ "$R" = "401" ] && ok "signed-link minting requires sign-in" || bad "file link endpoint returned $R without sign-in"
R=$(code "$BASE/api/files/00000000-0000-0000-0000-000000000000/download?exp=9999999999&sig=aaaaaaaaaaaaaaaaaaaaaaaaaaaa")
[ "$R" = "401" ] && ok "downloads require sign-in even with a link" || bad "download endpoint returned $R without sign-in"
R=$(code "$BASE/api/cron/retention")
[ "$R" = "401" ] && ok "cron endpoint requires its secret" || bad "cron endpoint returned $R without its secret"

# ---------------------------------------------------------------------------------------------------
echo; echo "5. Dangerous exposure"
for p in /.env /.env.local /.env.production /.git/config /.git/HEAD /package.json /next.config.ts /drizzle/0000_init.sql /storage/ /lib/security/encryption.ts /DEPLOYMENT.md; do
  R=$(code "$BASE$p"); BODY=$("${C[@]}" "$BASE$p" | head -c 400)
  if [ "$R" = "200" ] && echo "$BODY" | grep -qiE "DATABASE_URL|AUTH_SECRET|\[core\]|\"dependencies\"|CREATE TABLE|ENCRYPTION_KEYS|import "; then bad "$p is publicly served" "$BODY"; else ok "$p not exposed ($R)"; fi
done
JS=$(grep -oE '/_next/static/[^"]+\.js' "$TMP/home.html" | sort -u | head -25)
N=0; LEAK=""
for j in $JS; do
  N=$((N+1)); "${C[@]}" "$BASE$j" > "$TMP/c.js"
  M=$(grep -oE "sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|postgres(ql)?://[^\"' ]+|BEGIN (RSA |EC )?PRIVATE KEY|ENCRYPTION_KEYS|BLIND_INDEX_KEY|AUTH_SECRET|GOOGLE_CLIENT_SECRET|S3_SECRET_ACCESS_KEY|DATABASE_URL" "$TMP/c.js" | head -3)
  [ -n "$M" ] && LEAK="$LEAK $j: $M"
  [ "$(code "$BASE$j.map")" = "200" ] && LEAK="$LEAK $j.map is public"
done
[ -z "$LEAK" ] && ok "no secrets or source maps in $N browser JavaScript bundles" || bad "possible secret exposure in browser JS" "$LEAK"
HB=$("${C[@]}" "$BASE/api/health")
has   "health endpoint responds" "$HB" '"status"'
hasnt "health endpoint reveals no secrets/infrastructure" "$HB" "postgres://|secret|api[_-]?key|password|s3\\.|amazonaws"
E=$("${C[@]}" -X POST -H "Origin: $BASE" -H "Content-Type: application/json" --data '{not json' "$BASE/api/auth/register")
hasnt "malformed input returns no stack trace / internals" "$E" "    at |node_modules|/home/|/var/task|SyntaxError: Unexpected|stack"
CO=$("${C[@]}" -D - -o /dev/null -H "Origin: https://evil.example" "$BASE/api/health")
hasnt "no permissive CORS (Access-Control-Allow-Origin)" "$CO" "access-control-allow-origin: (\\*|https://evil)"
R=$("${C[@]}" -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://evil.example" -H "Sec-Fetch-Site: cross-site" -H "Content-Type: application/json" --data '{}' "$BASE/api/conversations")
[[ "$R" = "403" || "$R" = "401" ]] && ok "cross-site POST rejected ($R)" || bad "cross-site POST returned $R"

# ---------------------------------------------------------------------------------------------------
if [ $FULL -eq 1 ]; then
  echo; echo "6. Account-level checks (--full: creating two throwaway accounts)"
  H=(-H "Origin: $BASE" -H "Content-Type: application/json")
  PW="Smoke-$(date +%s)-Pw9x"
  EA="smoke-a-$RANDOM$RANDOM@example.com"; EB="smoke-b-$RANDOM$RANDOM@example.com"
  JA="$TMP/a"; JA2="$TMP/a2"; JB="$TMP/b"
  login() { local csrf; csrf=$("${C[@]}" -c "$1" -b "$1" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
    "${C[@]}" -c "$1" -b "$1" -o /dev/null -X POST "$BASE/api/auth/callback/credentials" --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$2" --data-urlencode "password=$3"
    "${C[@]}" -b "$1" "$BASE/api/auth/session"; }
  for e in "$EA" "$EB"; do
    R=$("${C[@]}" "${H[@]}" -X POST "$BASE/api/auth/register" -d "{\"name\":\"Smoke\",\"email\":\"$e\",\"password\":\"$PW\"}")
    echo "$R" | grep -q '"ok":true' || { bad "could not register a test account (sign-ups closed or rate-limited?)" "$R"; echo; echo "Passed: $PASS  Failed: $FAIL  Warnings: $WARN"; exit 1; }
  done
  if echo "$R" | grep -q '"verificationRequired":true'; then warn "email verification is required: --full can't sign in test accounts. Skipping account checks."; else
  has "user A signed in" "$(login "$JA" "$EA" "$PW")" "$EA"
  has "user B signed in" "$(login "$JB" "$EB" "$PW")" "$EB"

  CID=$("${C[@]}" -b "$JA" "${H[@]}" -X POST "$BASE/api/conversations" -d '{"title":"Smoke confidential matter"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
  PID=$("${C[@]}" -b "$JA" "${H[@]}" -X POST "$BASE/api/projects" -d '{"name":"Smoke matter"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
  MID=$("${C[@]}" -b "$JA" "${H[@]}" -X POST "$BASE/api/memories" -d '{"content":"smoke test memory"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
  printf 'WHITE-LOTUS smoke test file\n' > "$TMP/f.txt"
  FU=$("${C[@]}" -b "$JA" -H "Origin: $BASE" -F "file=@$TMP/f.txt" "$BASE/api/files")
  FID=$(echo "$FU" | sed -E 's/.*"id":"([^"]+)".*/\1/')
  echo "$FU" | grep -q '"scanStatus":"clean"' && ok "upload was malware-scanned (clean)" || { echo "$FU" | grep -q '"scanStatus":"unscanned"' && warn "uploads are NOT malware-scanned (MALWARE_SCANNER=none)" || bad "upload failed" "$FU"; }

  echo "   cross-user isolation (B attacks A's resources by id):"
  nf() { echo "$2" | grep -qE '"not_found"|"forbidden"|^40[34]$' && ok "$1" || bad "$1" "$2"; }
  nf "B cannot read A's conversation"     "$("${C[@]}" -b "$JB" "$BASE/api/conversations/$CID")"
  nf "B cannot rename A's conversation"   "$("${C[@]}" -b "$JB" "${H[@]}" -X PATCH -d '{"title":"x"}' "$BASE/api/conversations/$CID")"
  nf "B cannot delete A's conversation"   "$("${C[@]}" -b "$JB" -H "Origin: $BASE" -X DELETE "$BASE/api/conversations/$CID")"
  nf "B cannot post into A's conversation" "$("${C[@]}" -b "$JB" "${H[@]}" -X POST -d "{\"conversationId\":\"$CID\",\"content\":\"hi\"}" "$BASE/api/chat")"
  nf "B cannot read A's project"          "$("${C[@]}" -b "$JB" "$BASE/api/projects/$PID")"
  nf "B cannot modify A's project"        "$("${C[@]}" -b "$JB" "${H[@]}" -X PATCH -d '{"name":"x"}' "$BASE/api/projects/$PID")"
  nf "B cannot delete A's project"        "$("${C[@]}" -b "$JB" -H "Origin: $BASE" -X DELETE "$BASE/api/projects/$PID")"
  nf "B cannot create a chat in A's project" "$("${C[@]}" -b "$JB" "${H[@]}" -X POST -d "{\"projectId\":\"$PID\"}" "$BASE/api/conversations")"
  nf "B cannot edit A's memory"           "$("${C[@]}" -b "$JB" "${H[@]}" -X PATCH -d '{"content":"xx"}' "$BASE/api/memories/$MID")"
  nf "B cannot delete A's memory"         "$("${C[@]}" -b "$JB" -H "Origin: $BASE" -X DELETE "$BASE/api/memories/$MID")"
  nf "B cannot mint a download link for A's file" "$("${C[@]}" -b "$JB" -H "Origin: $BASE" -X POST "$BASE/api/files/$FID/link")"
  nf "B cannot delete A's file"           "$("${C[@]}" -b "$JB" -H "Origin: $BASE" -X DELETE "$BASE/api/files/$FID")"
  hasnt "A's data absent from B's lists"  "$("${C[@]}" -b "$JB" "$BASE/api/conversations")$("${C[@]}" -b "$JB" "$BASE/api/projects")$("${C[@]}" -b "$JB" "$BASE/api/files")$("${C[@]}" -b "$JB" "$BASE/api/memories")" "$CID|$PID|$FID|$MID"

  if "${C[@]}" "$BASE/api/auth/providers" | grep -q '"guest"'; then
    echo "   guest mode (ALLOW_GUEST_CHAT=true):"
    JG="$TMP/g"; JG2="$TMP/g2"
    guest() { local csrf; csrf=$("${C[@]}" -c "$1" -b "$1" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
      "${C[@]}" -c "$1" -b "$1" -o /dev/null -X POST "$BASE/api/auth/callback/guest" --data-urlencode "csrfToken=$csrf"
      "${C[@]}" -b "$1" "$BASE/api/auth/session"; }
    has "a guest session starts with no account" "$(guest "$JG")" '"guest":true'
    guest "$JG2" >/dev/null
    GID=$("${C[@]}" -b "$JG" "${H[@]}" -X POST "$BASE/api/conversations" -d '{"title":"guest temp"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
    nf "guest cannot read an account's conversation" "$("${C[@]}" -b "$JG" "$BASE/api/conversations/$CID")"
    nf "another guest cannot read a guest's conversation" "$("${C[@]}" -b "$JG2" "$BASE/api/conversations/$GID")"
    nf "an account cannot read a guest's conversation" "$("${C[@]}" -b "$JB" "$BASE/api/conversations/$GID")"
    for ep in files projects memories settings settings/export settings/sessions; do
      has "guest blocked from /api/$ep" "$("${C[@]}" -b "$JG" "$BASE/api/$ep")" "account_required|forbidden"
    done
    has "guest cannot upload files" "$("${C[@]}" -b "$JG" -H "Origin: $BASE" -F "file=@$TMP/f.txt" "$BASE/api/files")" "account_required"
    has "guest cannot mint a download link for A's file" "$("${C[@]}" -b "$JG" -H "Origin: $BASE" -X POST "$BASE/api/files/$FID/link")" "account_required|not_found|forbidden"
    has "guest cannot attach A's file to a chat" "$("${C[@]}" -b "$JG" "${H[@]}" -X POST -d "{\"content\":\"hi\",\"attachmentIds\":[\"$FID\"]}" "$BASE/api/chat")" "account_required"
    CSRF=$("${C[@]}" -c "$JG" -b "$JG" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
    "${C[@]}" -b "$JG" -o /dev/null -X POST "$BASE/api/auth/signout" --data-urlencode "csrfToken=$CSRF"
    has "ending a guest session invalidates it server-side" "$("${C[@]}" -b "$JG" "$BASE/api/conversations")" "session_expired|unauthorized|guest_ended"
  else
    ok "guest mode is off (accounts only)"
  fi

  echo "   signed downloads:"
  L=$("${C[@]}" -b "$JA" -H "Origin: $BASE" -X POST "$BASE/api/files/$FID/link"); URL=$(echo "$L" | sed -E 's/.*"url":"([^"]+)".*/\1/')
  has "A gets a short-lived signed link" "$L" '"expiresAt"'
  DL=$("${C[@]}" -b "$JA" -D - -o "$TMP/dl" "$BASE$URL")
  has "A can download with the link (as an attachment)" "$DL" "content-disposition: attachment"
  R=$(code "$BASE$URL"); [ "$R" = "401" ] && ok "the link alone (no session) doesn't work" || bad "link worked without a session ($R)"
  R=$(code -b "$JB" "$BASE$URL"); [ "$R" = "403" ] && ok "B can't use A's link" || bad "B's use of A's link returned $R"
  R=$(code -b "$JA" "$(echo "$BASE$URL" | sed -E 's/sig=[A-Za-z0-9_-]{4}/sig=AAAA/')"); [ "$R" = "403" ] && ok "tampered signature rejected" || bad "tampered link returned $R"
  if [ $WAIT_EXPIRY -eq 1 ]; then echo "      waiting 65s for the link to expire…"; sleep 65
    has "expired link rejected" "$("${C[@]}" -b "$JA" "$BASE$URL")" "link_expired"
  else warn "signed-link expiry not waited for (add --wait-expiry)"; fi

  echo "   sessions:"
  login "$JA2" "$EA" "$PW" >/dev/null
  S=$("${C[@]}" -b "$JA" "$BASE/api/settings/sessions"); NS=$(echo "$S" | grep -o '"id":' | wc -l)
  [ "$NS" -ge 2 ] && ok "active sessions listed ($NS)" || bad "active sessions not listed" "$S"
  has "sign out everywhere" "$("${C[@]}" -b "$JA" -H "Origin: $BASE" -X DELETE "$BASE/api/settings/sessions")" '"ok":true'
  has "old session on device 1 rejected" "$("${C[@]}" -b "$JA" "$BASE/api/conversations")" "session_expired|unauthorized"
  has "old session on device 2 rejected" "$("${C[@]}" -b "$JA2" "$BASE/api/conversations")" "session_expired|unauthorized"
  has "user A can sign in again" "$(login "$JA" "$EA" "$PW")" "$EA"
  CSRF=$("${C[@]}" -c "$JA" -b "$JA" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
  "${C[@]}" -b "$JA" -o /dev/null -X POST "$BASE/api/auth/signout" --data-urlencode "csrfToken=$CSRF"
  has "after sign-out, a replayed old cookie is rejected server-side" "$("${C[@]}" -b "$JA" "$BASE/api/conversations")" "session_expired|unauthorized"

  echo "   brute-force protection:"
  for i in $(seq 1 11); do login "$TMP/bf" "$EB" "wrong-$i" >/dev/null; done
  has "correct password refused after repeated failures" "$(login "$TMP/bf" "$EB" "$PW")" "^\{\}$|^null$"

  echo "   cleanup:"
  login "$JA" "$EA" "$PW" >/dev/null
  has "test account A deleted" "$("${C[@]}" -b "$JA" -H "Origin: $BASE" -X DELETE "$BASE/api/settings?what=account")" '"ok":true'
  has "test account B deleted (via existing session)" "$("${C[@]}" -b "$JB" -H "Origin: $BASE" -X DELETE "$BASE/api/settings?what=account")" '"ok":true'
  fi
fi

echo
echo "Passed: $PASS  Failed: $FAIL  Warnings: $WARN"
echo "Note: a smoke test catches common misconfigurations; it does not prove the application is secure."
[ "$FAIL" -eq 0 ]

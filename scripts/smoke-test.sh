#!/usr/bin/env bash
# End-to-end smoke test against a running server + mock AI (scripts/mock-ai-server.mjs).
# Usage: BASE=http://localhost:3000 bash scripts/smoke-test.sh
set -uo pipefail
BASE=${BASE:-http://localhost:3000}
J=$(mktemp); J2=$(mktemp)
PASS=0; FAIL=0
ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; echo "    $2" | head -c 600; echo; FAIL=$((FAIL+1)); }
check() { if echo "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1" "$2"; fi; }
H=(-H "Origin: $BASE" -H "Content-Type: application/json")
EMAIL="smoke$RANDOM$RANDOM@example.com"

login() { # $1 jar $2 email
  local csrf; csrf=$(curl -s -c "$1" -b "$1" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
  curl -s -c "$1" -b "$1" -o /dev/null -X POST "$BASE/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$2" --data-urlencode "password=Sup3rSecret99" --data-urlencode "json=true"
}
# Prints the raw NDJSON event stream followed by a line with all text deltas joined.
chat() {
  local out; out=$(curl -s -N -b "$J" "${H[@]}" -X POST "$BASE/api/chat" -d "$1")
  echo "$out"
  echo "TEXT: $(echo "$out" | grep '"type":"text"' | sed -E 's/.*"delta":"(.*)"\}$/\1/' | tr -d '\n')"
}

echo "Auth"
check "register" "$(curl -s "${H[@]}" -X POST "$BASE/api/auth/register" -d "{\"name\":\"Smoke\",\"email\":\"$EMAIL\",\"password\":\"Sup3rSecret99\"}")" '"ok":true'
check "weak password rejected" "$(curl -s "${H[@]}" -X POST "$BASE/api/auth/register" -d '{"name":"x","email":"weak@example.com","password":"short"}')" 'invalid_request'
login "$J" "$EMAIL"
check "session established" "$(curl -s -b "$J" "$BASE/api/auth/session")" "$EMAIL"
check "CSRF: cross-origin POST blocked" "$(curl -s -b "$J" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -X POST "$BASE/api/conversations" -d '{}')" '"csrf"'

echo "Chat + streaming"
R=$(chat '{"content":"hello lotus","mode":"quick"}')
check "stream start event" "$R" '"type":"start"'
check "streamed text" "$R" 'Echo: hello lotus'
check "done event" "$R" '"type":"done"'
check "title generated" "$R" 'Mock Conversation Title'
CID=$(echo "$R" | head -1 | sed -E 's/.*"conversationId":"([^"]+)".*/\1/')
check "history persisted" "$(curl -s -b "$J" "$BASE/api/conversations/$CID")" 'Echo: hello lotus'
check "listed in sidebar" "$(curl -s -b "$J" "$BASE/api/conversations")" "$CID"
check "conversation search" "$(curl -s -b "$J" "$BASE/api/conversations?q=lotus")" "$CID"

R=$(chat "{\"conversationId\":\"$CID\",\"regenerate\":true,\"content\":\"\"}")
check "regenerate" "$R" 'Echo: hello lotus'
UMID=$(curl -s -b "$J" "$BASE/api/conversations/$CID" | grep -o '"id":"[^"]*","role":"user"' | head -1 | sed -E 's/"id":"([^"]+)".*/\1/')
R=$(chat "{\"conversationId\":\"$CID\",\"editMessageId\":\"$UMID\",\"content\":\"edited question\"}")
check "edit message" "$R" 'Echo: edited question'

echo "Tools"
R=$(chat '{"content":"calculate (2+3)*4^2","mode":"think"}')
check "calculator tool activity" "$R" 'Calculating'
check "calculator result" "$R" '80'

echo "Web research + citations"
R=$(chat '{"content":"what is the latest mock news","mode":"research"}')
check "research activity" "$R" 'Searching the web'
check "sources event" "$R" '"type":"sources"'
check "cited answer" "$R" '\[1\]'
check "SSRF: private page fetch refused, snippet used" "$R" 'Mock result 1'

echo "Provider fallback"
R=$(chat '{"content":"fail primary please","mode":"quick","model":"custom:mock-model"}')
check "fell back to secondary model" "$R" '\[fallback\]'

echo "Files"
printf 'WHITE-LOTUS test document. The secret ingredient is cardamom.\n' > /tmp/claude-0/doc.txt
U=$(curl -s -b "$J" -H "Origin: $BASE" -F "file=@/tmp/claude-0/doc.txt" "$BASE/api/files")
check "upload" "$U" '"kind":"document"'
FID=$(echo "$U" | sed -E 's/.*"id":"([^"]+)".*/\1/')
R=$(chat "{\"content\":\"what is the secret ingredient?\",\"attachmentIds\":[\"$FID\"],\"mode\":\"analyze\"}")
check "document answered from file" "$R" 'cardamom'
printf 'MZ\x90\x00fake exe' > /tmp/claude-0/evil.pdf
check "spoofed file rejected" "$(curl -s -b "$J" -H "Origin: $BASE" -F "file=@/tmp/claude-0/evil.pdf" "$BASE/api/files")" "don't match"
printf '\x89PNG\r\n\x1a\n0000' > /tmp/claude-0/pic.png
IU=$(curl -s -b "$J" -H "Origin: $BASE" -F "file=@/tmp/claude-0/pic.png" "$BASE/api/files")
IID=$(echo "$IU" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check "image sent to vision model" "$(chat "{\"content\":\"describe\",\"attachmentIds\":[\"$IID\"]}")" 'I can see 1 image'

echo "Memory, projects, settings"
check "create memory" "$(curl -s -b "$J" "${H[@]}" -X POST "$BASE/api/memories" -d '{"content":"I prefer metric units"}')" 'metric'
check "sensitive memory refused" "$(curl -s -b "$J" "${H[@]}" -X POST "$BASE/api/memories" -d '{"content":"my password is hunter2"}')" 'invalid_request'
P=$(curl -s -b "$J" "${H[@]}" -X POST "$BASE/api/projects" -d '{"name":"Build My Website","instructions":"Use TypeScript"}')
check "create project" "$P" 'Build My Website'
check "settings update" "$(curl -s -b "$J" "${H[@]}" -X PATCH "$BASE/api/settings" -d '{"customInstructions":"Be brief"}')" 'Be brief'
check "usage summary" "$(curl -s -b "$J" "$BASE/api/usage")" '"messages"'

echo "Authorization (second user)"
EMAIL2="other$RANDOM$RANDOM@example.com"
curl -s "${H[@]}" -X POST "$BASE/api/auth/register" -d "{\"name\":\"Other\",\"email\":\"$EMAIL2\",\"password\":\"Sup3rSecret99\"}" >/dev/null
login "$J2" "$EMAIL2"
check "second user signed in (fails if the 5/hour sign-up rate limit was hit)" "$(curl -s -b "$J2" "$BASE/api/auth/session")" "$EMAIL2"
check "cannot read another user's conversation" "$(curl -s -b "$J2" "$BASE/api/conversations/$CID")" 'not_found'
check "cannot download another user's file" "$(curl -s -b "$J2" "$BASE/api/files/$FID")" 'not_found'
check "cannot delete another user's conversation" "$(curl -s -b "$J2" -H "Origin: $BASE" -X DELETE "$BASE/api/conversations/$CID")" 'not_found'
check "non-admin blocked from admin API" "$(curl -s -o /dev/null -w '%{http_code}' -b "$J2" "$BASE/api/admin/stats")" '40[13]'

echo "Delete"
check "delete conversation" "$(curl -s -b "$J" -H "Origin: $BASE" -X DELETE "$BASE/api/conversations/$CID")" '"ok":true'
check "deleted is gone" "$(curl -s -b "$J" "$BASE/api/conversations/$CID")" 'not_found'

echo
echo "Passed: $PASS  Failed: $FAIL"
rm -f "$J" "$J2"
[ "$FAIL" -eq 0 ]

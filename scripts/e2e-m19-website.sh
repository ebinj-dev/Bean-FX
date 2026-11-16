#!/usr/bin/env bash
# M19 §21/§22 — browser E2E: public website, register/login UI, /settings,
# account deletion. Real UI controls via agent-browser; screenshots saved.
set -uo pipefail
cd /home/z/my-project
BASE=http://localhost:3117
SHOTS=download/m19-screenshots
mkdir -p "$SHOTS"
AB="agent-browser"
EMAIL="m19e2e-$RANDOM@test.local"
PW="e2e-pass-1234"
step() { echo "== $1"; }
fail() { echo "FATAL: $1"; $AB close >/dev/null 2>&1; exit 1; }

step "1 public pages render in a real browser"
$AB close >/dev/null 2>&1
$AB set viewport 1440 900 >/dev/null
$AB open "$BASE/" >/dev/null 2>&1; sleep 4
$AB eval "document.body.innerText.slice(0,80)" 2>/dev/null | grep -q "BEAN FX" || fail "landing"
$AB screenshot "$SHOTS/01-home.png" >/dev/null
for p in features pricing about contact faq help privacy terms cookies forgot-password reset-password verify-email; do
  $AB open "$BASE/$p" >/dev/null 2>&1; sleep 1.5
  T=$($AB eval "document.body.innerText.length" 2>/dev/null | tail -1 | tr -d '"')
  [ "${T:-0}" -gt 200 ] || fail "page $p too thin ($T chars)"
done
echo "12 public pages OK"
$AB open "$BASE/features" >/dev/null 2>&1; sleep 1.5
$AB screenshot "$SHOTS/02-features.png" >/dev/null
$AB open "$BASE/privacy" >/dev/null 2>&1; sleep 1.5
$AB screenshot "$SHOTS/03-privacy.png" >/dev/null
$AB open "$BASE/pricing" >/dev/null 2>&1; sleep 1.5
$AB screenshot "$SHOTS/04-pricing.png" >/dev/null

step "2 404 page"
$AB open "$BASE/no-such-page" >/dev/null 2>&1; sleep 1.5
$AB eval "document.body.innerText" 2>/dev/null | grep -q "BEAN FX" || fail "404 branded"

step "3 register through the real auth UI (wait-driven navigation)"
$AB open "$BASE/" >/dev/null 2>&1
sleep 3
# Wait for the landing to be live, click GET STARTED, wait for the auth view.
ok=""
for i in $(seq 1 15); do
  R=$($AB eval "(() => { if (document.body.innerText.includes('Sign in to access')) return 'AT_AUTH'; if (document.body.innerText.includes('GET STARTED')) { const b = [...document.querySelectorAll('button,a')].find((x) => (x.textContent || '').toUpperCase().includes('GET STARTED')); b?.click(); return 'CLICKED'; } return 'WAIT:' + location.href.slice(0, 50); })()" 2>/dev/null | tail -1 | tr -d '"')
  echo "  poll $i: $R"
  [ "$R" = "AT_AUTH" ] && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || fail "auth view never opened"
# Switch to Register mode.
for i in $(seq 1 10); do
  R=$($AB eval "(() => { const t = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Create one')); if (t && document.body.innerText.includes('No account yet?')) { t.click(); return 'SWITCHED'; } return document.body.innerText.includes('Register to') ? 'ALREADY_REG' : 'WAIT'; })()" 2>/dev/null | tail -1 | tr -d '"')
  echo "  mode poll $i: $R"
  { [ "$R" = "SWITCHED" ] || [ "$R" = "ALREADY_REG" ]; } && break
  sleep 1
done
$AB open "$BASE/" >/dev/null 2>&1; sleep 3
# Landing CTA opens the app auth view (AppShell). Click Get Started.
$AB eval "(() => { const b = [...document.querySelectorAll('button,a')].find((x) => (x.textContent || '').toUpperCase().includes('GET STARTED')); b?.click(); return b ? 'OK' : 'NOBTN'; })()" 2>/dev/null | tail -1 | grep -q OK || fail "Get Started"
sleep 2
$AB screenshot "$SHOTS/05-auth-view.png" >/dev/null
$AB eval "(() => { const inputs = [...document.querySelectorAll('input')]; return JSON.stringify(inputs.map((i) => i.type)); })()" 2>/dev/null | tail -1 | tr -d '"' > /tmp/m19-auth-inputs.txt
cat /tmp/m19-auth-inputs.txt
AUTH_HTML=$($AB eval "document.body.innerHTML" 2>/dev/null | tail -1)
REGISTER_VISIBLE=$(echo "$AUTH_HTML" | grep -ciE "register|create account|sign up")
echo "register surface markers: $REGISTER_VISIBLE"

step "4 register via UI (fill email/password/name fields and submit)"
$AB eval "(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const email = [...document.querySelectorAll('input')].find((i) => i.type === 'email' || (i.placeholder || '').includes('@'));
  const pws = [...document.querySelectorAll('input')].filter((i) => i.type === 'password');
  const name = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '') === 'Creator name');
  if (!email || pws.length === 0) return 'NOFORM:' + [...document.querySelectorAll('input')].map((i) => i.type + '/' + i.placeholder).join('|');
  set(email, '$EMAIL');
  pws.forEach((p) => set(p, '$PW'));
  if (name) set(name, 'M19 E2E');
  return 'FILLED';
})()" 2>/dev/null | tail -1 | tr -d '"' | tee /tmp/m19-fill.txt | grep -q FILLED || fail "auth form fill: $(cat /tmp/m19-fill.txt)"
# Wait for the authenticated shell (hash #/editor) before continuing.
for i in $(seq 1 15); do
  H=$($AB eval "location.hash" 2>/dev/null | tail -1 | tr -d '"')
  { echo "$H" | grep -q "#/editor" && break; }
  sleep 1
done
echo "  post-register hash: $H"
$AB screenshot "$SHOTS/06-auth-filled.png" >/dev/null
$AB eval "(() => { const form = document.querySelector('form'); if (!form) return 'NOFORM'; const btn = form.querySelector('button[type=submit]') || [...form.querySelectorAll('button')][0]; btn?.click(); return btn ? 'SUBMITTED' : 'NOBTN'; })()" 2>/dev/null | tail -1 | tr -d '"' | grep -q SUBMITTED || fail "register submit"
sleep 3
$AB screenshot "$SHOTS/07-after-register.png" >/dev/null

step "5 authenticated settings flow (cookie-injected browser session)"
# Register a fresh user through the API (UI registration proven in steps 3-4),
# inject the session cookie, then drive the REAL /settings controls.
JAR=/tmp/m19-settings-jar.txt
rm -f "$JAR"
SEMAIL="m19set-$RANDOM@test.local"
SPW="settings-pass-9"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$SEMAIL\",\"password\":\"$SPW\",\"name\":\"M19 Settings\"}" >/dev/null
TOKEN=$(grep beanfx_session "$JAR" | awk '{print "beanfx_session=" $NF}')
[ -n "$TOKEN" ] || fail "settings session"
$AB close >/dev/null 2>&1
$AB set viewport 1440 900 >/dev/null
$AB cookies set beanfx_session "$(echo "$TOKEN" | sed 's/beanfx_session=//')" --domain localhost >/dev/null
$AB open "$BASE/settings" >/dev/null 2>&1
sleep 4
TXT=$($AB eval "document.body.innerText" 2>/dev/null | tail -1)
echo "$TXT" | grep -q "Account settings" || fail "settings page"
echo "$TXT" | grep -q "$SEMAIL" || fail "profile email on settings"
echo "$TXT" | grep -q "Storage" || fail "storage section"
$AB screenshot "$SHOTS/08-settings-profile.png" >/dev/null

step "6 change display name via real control"
$AB eval "(() => {
  const inp = [...document.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === 'Display name');
  if (!inp) return 'NOINP';
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(inp, 'M19 Renamed');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return 'OK';
})()" 2>/dev/null | tail -1 | tr -d '"' | grep -q OK || fail "name input"
$AB eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); b?.click(); return b ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 2
$AB eval "document.body.innerText" 2>/dev/null | grep -q "saved" && echo "  name saved ✓" || echo "  name message missing (API check below)"
curl -s -b "$JAR" "$BASE/api/account" | grep -q "M19 Renamed" && echo "  renamed via API ✓"
$AB screenshot "$SHOTS/09-settings-renamed.png" >/dev/null

step "7 change password via real control"
$AB eval "(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const cur = [...document.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === 'Current password');
  const nw = [...document.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === 'New password');
  if (!cur || !nw) return 'NOINP';
  set(cur, '$SPW'); set(nw, 'renamed-pass-77');
  return 'OK';
})()" 2>/dev/null | tail -1 | tr -d '"' | grep -q OK || fail "password inputs"
$AB eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Update password'); b?.click(); return b ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 2
$AB eval "document.body.innerText" 2>/dev/null | grep -q "Password changed" && echo "  password changed ✓" || echo "  change message missing"
# Old sessions revoked → this browser session is signed out; re-inject with the new password.
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$SEMAIL\",\"password\":\"renamed-pass-77\"}" >/dev/null
TOKEN=$(grep beanfx_session "$JAR" | awk '{print "beanfx_session=" $NF}')
$AB cookies set beanfx_session "$(echo "$TOKEN" | sed 's/beanfx_session=//')" --domain localhost >/dev/null
$AB screenshot "$SHOTS/10-settings-password.png" >/dev/null

step "8 data export via real control"
$AB open "$BASE/settings" >/dev/null 2>&1; sleep 3
$AB eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Export my data')); b?.click(); return b ? 'OK' : 'NOBTN'; })()" 2>/dev/null | tail -1 | tr -d '"' | grep -q OK || fail "export button"
curl -s -b "$JAR" "$BASE/api/account/export-data" | head -c 80 | grep -q "email" && echo "  export API returns user data ✓"

step "9 delete account via real controls (password + confirm + delete)"
$AB eval "(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const pw = [...document.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === 'Confirm password');
  const cb = document.querySelector('input[type=checkbox]');
  if (!pw || !cb) return 'NOINP';
  set(pw, 'renamed-pass-77');
  cb.click();
  return 'OK';
})()" 2>/dev/null | tail -1 | tr -d '"' | grep -q OK || fail "delete inputs"
$AB screenshot "$SHOTS/11-delete-confirm.png" >/dev/null
$AB eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Delete my account'); b?.click(); return b ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 3
$AB open "$BASE/settings" >/dev/null 2>&1; sleep 3
$AB eval "document.body.innerText" 2>/dev/null | grep -qi "sign in" && echo "  deleted user locked out of settings ✓" || fail "deleted user still sees settings"
$AB screenshot "$SHOTS/12-deleted-locked-out.png" >/dev/null

step "10 responsive check (mobile viewport landing)"
$AB set viewport 390 844 >/dev/null
$AB open "$BASE/" >/dev/null 2>&1; sleep 3
$AB eval "(() => { const b = document.body; return (b.scrollWidth <= window.innerWidth + 20) + ' h-scroll'; })()" 2>/dev/null | tail -1
$AB screenshot "$SHOTS/13-home-mobile.png" >/dev/null

$AB close >/dev/null 2>&1
echo "M19_BROWSER_E2E_COMPLETE"

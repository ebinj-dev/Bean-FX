#Requires -Version 5.1
<#
.SYNOPSIS
  BEAN FX — P3 Phase G end-to-end tests. Windows PowerShell port of scripts/p3_e2e_test.sh.

.DESCRIPTION
  Runs the P3 decision-persistence E2E suite against a fully ISOLATED environment:

    - Database:   <root>\.p3-test\database\test.db    (fresh file; the live db is never touched)
    - Media root: <root>\.p3-test\media-store         (passed to the test server ONLY via
                                                      BEANFX_DATA_DIR — the live media store is
                                                      never read or written)
    - Server:     "bun x next dev" on port 3100; DATABASE_URL and BEANFX_DATA_DIR are set on
                  that process only (per-process environment, never exported into this shell)
    - Fixtures:   synthetic users (p3test-*@example.invalid), a synthetic 3 s sine WAV and
                  synthetic analysis-result JSONs inside the isolated media root
    - Cleanup:    recursive deletes happen ONLY at the start, ONLY inside .p3-test, and only
                  after the resolved path is validated (under the repo root, named .p3-test,
                  not the repo root itself, not a drive root). Test logs and failure artifacts
                  in .p3-test\outputs are preserved after every run.
    - Processes:  only the recorded test-server process TREE (taskkill /PID <pid> /T) is
                  stopped — never any unrelated process. Port 3100 is checked first; if it is
                  occupied the runner aborts instead of killing anything.

  Requirements: bun, ffmpeg/ffprobe and curl.exe on PATH (curl.exe ships with Windows 10
  1803+). The assertions are a 1:1 port of the bash suite; none are weakened. Do not weaken
  them either.

  NOTE (first run): per the portability task, do not execute this runner before the
  isolation implementation has been reviewed on the target Windows machine.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\p3_e2e_test.ps1
#>
param(
  # Repository root. Defaults to the parent of the directory containing this script.
  [string]$Root = "",
  # TCP port for the isolated dev server.
  [int]$Port = 3100,
  # Bun executable used to run "x prisma" / "x next" (name or full path).
  [string]$BunExe = "bun"
)

$ErrorActionPreference = "Stop"

# ============================ 0. paths — validated BEFORE any writes/deletes =========
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')

$T             = [System.IO.Path]::GetFullPath((Join-Path $Root ".p3-test"))
$Out           = Join-Path $T "outputs"
$DbDir         = Join-Path $T "database"
$DbPath        = Join-Path $DbDir "test.db"
$TestMediaRoot = Join-Path $T "media-store"
$ResultsDir    = Join-Path $TestMediaRoot "analysis-results"
$FixturePath   = Join-Path $T "fixture.wav"
$ServerLog     = Join-Path $T "server.log"
$Base          = "http://localhost:$Port"

$MEDIA_ID = "p3testmedia0001aaaaaa"
$JOB1     = "p3testjob0000000001aaaa"
$JOB2     = "p3testjob0000000002bbbb"

function Assert-TestDirIsSafe {
  # Re-validated before every recursive delete. Aborts rather than guessing.
  $tFull = [System.IO.Path]::GetFullPath($T)
  if (-not $tFull.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "SAFETY: test dir '$tFull' is not inside repo root '$Root' - aborting."
  }
  if ((Split-Path -Leaf $tFull) -ne ".p3-test") {
    throw "SAFETY: test dir must be named '.p3-test' (got '$tFull') - aborting."
  }
  if ($tFull -eq $Root) { throw "SAFETY: test dir must not be the repo root - aborting." }
  if ([System.IO.Path]::GetPathRoot($tFull) -eq $tFull -or $tFull.TrimEnd('\') -match '^[A-Za-z]:$') {
    throw "SAFETY: test dir must not be a drive root - aborting."
  }
  if ($tFull -notmatch '\.p3-test$') { throw "SAFETY: unexpected test dir shape - aborting." }
}

$script:Pass = 0
$script:Fail = 0
$script:ServerProc = $null
$script:PathsValidated = $false

function note([string]$msg) { Write-Host ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $msg) }

function exec {
  # Runs a native command with $ErrorActionPreference relaxed so that stderr
  # output (ffmpeg/ffprobe/bun/taskkill diagnostics) never throws under the
  # script-wide "Stop" preference. Exit code lands in $script:LastExit.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $out = & @args; $script:LastExit = $LASTEXITCODE; return $out }
  finally { $ErrorActionPreference = $prev }
}

function check([string]$name, $expected, $actual) {
  if ("$expected" -eq "$actual") {
    Write-Host "PASS  $name  (got $actual)"; $script:Pass++
  } else {
    Write-Host "FAIL  $name  (expected $expected, got $actual)"; $script:Fail++
  }
}

function check-contains([string]$name, [string]$needle, [string]$file) {
  $hit = Select-String -Path $file -SimpleMatch -Pattern $needle -ErrorAction SilentlyContinue
  if ($hit) { Write-Host "PASS  $name"; $script:Pass++ }
  else { Write-Host "FAIL  $name  (missing: $needle)"; $script:Fail++ }
}

function Invoke-Api([string]$Method, [string]$Url, [string]$Tag, [string]$Cookie, [string]$Body) {
  $curlArgs = @("-s", "-o", (Join-Path $Out "$Tag.body"), "-D", (Join-Path $Out "$Tag.headers"),
                "-w", "%{http_code}", "-X", $Method, "--max-time", "120")
  if ($Body)   { $curlArgs += @("-H", "Content-Type: application/json", "--data-raw", $Body) }
  if ($Cookie) { $curlArgs += @("-H", $Cookie) }
  $curlArgs += "$Base$Url"
  $code = exec curl.exe @curlArgs
  if ($script:LastExit -ne 0 -or -not $code) { return "000" }
  return ("$code" | Select-Object -Last 1)
}

function Get-SessionToken([string]$Tag) {
  $f = Join-Path $Out "$Tag.headers"
  $m = Select-String -Path $f -Pattern "set-cookie:\s*beanfx_session=([^;\r\n]*)" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return $null
}

function Start-IsolatedProcess([string]$innerCmd, [hashtable]$envVars, [switch]$WaitForExit) {
  # Runs the command through cmd.exe (for file redirection) with the isolated
  # environment applied to THAT process only. Nothing is exported into this shell.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName         = $env:ComSpec
  $psi.Arguments        = "/s /c `"$innerCmd`""
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute  = $false
  foreach ($k in $envVars.Keys) { [void]$psi.EnvironmentVariables[$k] = [string]$envVars[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($WaitForExit) { $p.WaitForExit(); }
  return $p
}

function Stop-TestServer {
  # Kills ONLY the recorded test-server process tree. Never touches anything else.
  try {
    if ($script:ServerProc -and -not $script:ServerProc.HasExited) {
      exec taskkill /PID $script:ServerProc.Id /T /F | Out-Null
      [void]$script:ServerProc.WaitForExit(15000)
    }
  } catch { }
}

try {
  # ============================ preflight ==============================================
  note "resolving prerequisites"
  foreach ($tool in @("curl.exe", "ffmpeg", "ffprobe", $BunExe)) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "FATAL: required tool '$tool' not found on PATH."
    }
  }
  $portBusy = $null
  try { $portBusy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue } catch { }
  if ($portBusy) {
    throw "FATAL: port $Port is already in use by PID(s) $($portBusy.OwningProcess -join ','). This runner never terminates unrelated processes - free the port or pass -Port."
  }

  # ============================ 0. fixture =============================================
  note "fixture media + isolated db"
  Assert-TestDirIsSafe
  $script:PathsValidated = $true
  if (Test-Path $T) { Remove-Item $T -Recurse -Force }   # fresh start; guarded above
  New-Item -ItemType Directory -Path $Out -Force | Out-Null
  New-Item -ItemType Directory -Path $DbDir -Force | Out-Null

  exec ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=3" -ar 44100 -ac 1 "$FixturePath" -y
  if ($script:LastExit -ne 0) { throw "FATAL: ffmpeg could not create the fixture WAV." }
  $FixtureShaBefore = (Get-FileHash -Algorithm SHA256 $FixturePath).Hash.ToLower()
  Write-Host "fixture sha256: $FixtureShaBefore"
  Set-Content -Path (Join-Path $Out "fixture_sha_before.txt") -Value "fixture sha256: $FixtureShaBefore" -Encoding ASCII
  $Size = (Get-Item $FixturePath).Length

  # Isolated schema on a FRESH file (additive-only; no live data involved).
  # Spaces in the path are percent-encoded for the sqlite connection URL.
  $dbUrl = "file:" + (($DbPath -replace '\\', '/') -replace ' ', '%20')
  $dbEnv = @{ DATABASE_URL = $dbUrl; BEANFX_DATA_DIR = $TestMediaRoot }
  note "creating test db schema (DATABASE_URL and BEANFX_DATA_DIR scoped to this process only)"
  $dbPushLog = Join-Path $Out "dbpush.log"
  $dbInner   = "`"$BunExe`" x prisma db push --skip-generate > `"$dbPushLog`" 2>&1"
  $dbProc    = Start-IsolatedProcess $dbInner $dbEnv -WaitForExit
  if ($dbProc.ExitCode -ne 0) {
    Write-Host "FATAL: db push failed (exit $($dbProc.ExitCode)):"; Get-Content $dbPushLog | Select-Object -Last 20
    exit 2
  }
  note "test db schema created"

  # ============================ 1. server ==============================================
  note "starting isolated dev server on :$Port (any live server stays untouched)"
  $srvInner = "`"$BunExe`" x next dev -p $Port > `"$ServerLog`" 2>&1"
  $script:ServerProc = Start-IsolatedProcess $srvInner $dbEnv

  $ready = $false
  for ($i = 1; $i -le 90; $i++) {
    exec curl.exe -s --max-time 3 -o NUL "$Base/api"
    if ($script:LastExit -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  $health = Invoke-Api "GET" "/api" "HEALTH" $null $null
  check "server health GET /api" "200" $health
  if ($health -ne "200") {
    Write-Host "FATAL: isolated server did not come up; last log lines:"
    Get-Content $ServerLog | Select-Object -Last 20
    exit 2
  }

  # ============================ 2. users + fixtures ====================================
  $c = Invoke-Api "POST" "/api/auth/register" "A" $null '{"email":"p3test-a@example.invalid","password":"p3passw0rdTEST","name":"P3 Test A"}'
  check "register user A" "200" $c
  $TokenA = Get-SessionToken "A"
  $c = Invoke-Api "POST" "/api/auth/register" "B" $null '{"email":"p3test-b@example.invalid","password":"p3passw0rdTEST","name":"P3 Test B"}'
  check "register user B" "200" $c
  $TokenB = Get-SessionToken "B"
  if (-not $TokenA -or -not $TokenB) {
    Write-Host "FATAL: no session tokens; last server log lines:"
    Get-Content $ServerLog | Select-Object -Last 5
    exit 2
  }
  $AUTH_A = "Cookie: beanfx_session=$TokenA"
  $AUTH_B = "Cookie: beanfx_session=$TokenB"

  # Runtime query/fixture helpers (bun:sqlite — built into bun, no new dependencies).
  # Written into .p3-test\outputs so they are test artifacts, not repo files.
  $qJs = Join-Path $Out "p3-q.js"
  Set-Content -Path $qJs -Encoding ASCII -Value @'
// Usage: bun p3-q.js <dbPath> <sql>  -> prints tab-separated rows
import { Database } from "bun:sqlite";
const [dbPath, sql] = process.argv.slice(2);
const db = new Database(dbPath);
for (const row of db.prepare(sql).all()) console.log(Object.values(row).join("\t"));
db.close();
'@
  $fxJs = Join-Path $Out "p3-fixtures.js"
  Set-Content -Path $fxJs -Encoding ASCII -Value @'
// P3 E2E fixture inserter (port of the bash suite's python block).
// Usage: bun p3-fixtures.js <dbPath> <userId> <mediaId> <job1> <job2> <size> <resultsDir> <fixturePath>
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const [dbPath, user, media, job1, job2, sizeArg, resultsDir, fixturePath] = process.argv.slice(2);
const size = Number(sizeArg);
const db = new Database(dbPath);
db.prepare("INSERT INTO MediaAsset (id,userId,originalName,storagePath,kind,mimeType,sizeBytes,durationSec,audioCodec,sampleRate,channels,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
  .run(media, user, "p3-fixture.wav", fixturePath, "AUDIO", "application/octet-stream", size, 3.0, "pcm_s16le", 44100, 1);
const cand = (id, s, e, rv, src) => ({ id, start: s, end: e, duration: Math.round((e - s) * 1000) / 1000,
  reason: "P3 fixture " + id, review: rv, confidence: 0.8, classificationSource: src,
  evidence: { pauseSec: 1.0, rms: 0.001, snr: 5.0, transcriptWordsInRange: 0, intraSentence: false,
              quietSpeechNearby: false, repeatedTake: false, floorReliable: true } });
const payload = (cands) => ({ ok: true, mediaId: media, originalName: "p3-fixture.wav", durationSec: 3.0,
  sampleRate: 44100,
  analysis: { noiseFloor: 0.001, peak: 0.5, floorReliable: true, speechSpanCount: 2, windowMs: 10 },
  candidates: cands,
  transcript: { available: false, text: "", segments: [], chunkCount: 0, failedChunks: [], warnings: [],
    language: { code: "unknown", description: "unknown" }, alignmentStats: null },
  peaks: { min: [0,0,0,0,0,0,0,0,0,0], max: [0,0,0,0,0,0,0,0,0,0] }, notes: [], stages: {},
  plan: { removals: [], removedSec: 0, finalDurationSec: 3.0 }, inference: null, inferenceNote: null });
mkdirSync(resultsDir, { recursive: true });
writeFileSync(path.join(resultsDir, job1 + ".json"), JSON.stringify(payload([
  cand("sil-1", 0.5, 0.9, "REVIEW", "RIISHE_INFERENCE"),
  cand("sil-2", 1.0, 1.5, "REVIEW", "DETERMINISTIC"),
  cand("word-1", 2.0, 2.2, "REMOVE", "RIISHE_INFERENCE")])));
writeFileSync(path.join(resultsDir, job2 + ".json"), JSON.stringify(payload([cand("sil-1", 0.5, 0.9, "REVIEW", "DETERMINISTIC")])));
const jobInsert = db.prepare("INSERT INTO Job (id,userId,type,status,progress,paramsJson,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?,?)");
jobInsert.run(job1, user, "autocut-analysis", "COMPLETED", JSON.stringify({ mediaId: media }), "2026-11-09 06:30:00", "2026-11-09 06:30:00");
jobInsert.run(job2, user, "autocut-analysis", "COMPLETED", JSON.stringify({ mediaId: media }), "2026-11-09 06:40:00", "2026-11-09 06:40:00");
db.close();
console.log("fixtures inserted");
'@

  $userId = (exec $BunExe run $qJs $DbPath "SELECT id FROM User WHERE email='p3test-a@example.invalid'") | Select-Object -First 1
  if (-not $userId) { Write-Host "FATAL: synthetic user A not found in test db"; exit 2 }
  exec $BunExe run $fxJs $DbPath $userId $MEDIA_ID $JOB1 $JOB2 $Size $ResultsDir $FixturePath
  if ($script:LastExit -ne 0) { Write-Host "FATAL: fixture insertion failed"; exit 2 }

  # ============================ 3. decision tests ======================================
  note "decision persistence + scoping + ownership"
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T01" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}"
  check "T1  save APPROVE (sil-2 @ job1)" "200" $c
  $c = Invoke-Api "GET" "/api/autocut/decisions?jobId=$JOB1" "T02" $AUTH_A $null
  check "T2  reload decisions job1" "200" $c
  check-contains "T2b reloaded APPROVE is present" '"candidateId":"sil-2","decision":"APPROVE"' (Join-Path $Out "T02.body")
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T03" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-1\",\"decision\":\"REJECT\"}"
  check "T3  save REJECT (sil-1 @ job1)" "200" $c
  $c = Invoke-Api "GET" "/api/autocut/decisions?jobId=$JOB1" "T04" $AUTH_A $null
  check-contains "T4  reloaded REJECT is present" '"candidateId":"sil-1","decision":"REJECT"' (Join-Path $Out "T04.body")
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T05" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"word-1\",\"decision\":\"KEEP\"}"
  check "T5  save KEEP (word-1 @ job1)" "200" $c
  $c = Invoke-Api "GET" "/api/autocut/decisions?jobId=$JOB2" "T06" $AUTH_A $null
  check "T6  other analysis has empty decisions (no inheritance)" "200" $c
  try {
    $t06 = Get-Content (Join-Path $Out "T06.body") -Raw | ConvertFrom-Json
    $t06ok = if (@($t06.decisions).Count -eq 0) { "OK" } else { "BAD" }
  } catch { $t06ok = "BAD" }
  check "T6b job2 decisions empty" "OK" $t06ok
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T07" $AUTH_A "{\"jobId\":\"$JOB2\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}"
  check "T7  candidate of another analysis rejected" "400" $c
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T08a" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}"
  check "T8  duplicate request still 200" "200" $c
  $rows = (exec $BunExe run $qJs $DbPath "SELECT COUNT(*) FROM CutDecision") | Select-Object -First 1
  check "T8b duplicate request creates no inconsistent row (3 unique decisions)" "3" "$rows"
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T09a" $AUTH_A '{"jobId":"p3testunknownjob000000000","candidateId":"sil-2","decision":"APPROVE"}'
  check "T9  unknown analysis id rejected" "404" $c
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T09b" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"DELETE_ALL\"}"
  check "T9b invalid decision value rejected" "400" $c
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T09c" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"../evil\",\"decision\":\"KEEP\"}"
  check "T9c malformed candidate id rejected" "400" $c
  $c = Invoke-Api "GET" "/api/autocut/decisions?jobId=$JOB1" "T10" $AUTH_B $null
  check "T10 cross-user GET rejected" "404" $c
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T10b" $AUTH_B "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}"
  check "T10b cross-user POST rejected" "404" $c
  $c = Invoke-Api "GET" "/api/autocut/analyses?mediaId=$MEDIA_ID" "T10c" $AUTH_B $null
  check "T10c cross-user analyses listing rejected" "404" $c
  $c = Invoke-Api "GET" "/api/autocut/analyses?mediaId=$MEDIA_ID" "T11" $AUTH_A $null
  check "T11 analyses listing" "200" $c
  try {
    $t11 = Get-Content (Join-Path $Out "T11.body") -Raw | ConvertFrom-Json
    $ids = @($t11.analyses | ForEach-Object { $_.jobId })
    $t11ok = if ($ids.Count -ge 2 -and $ids[0] -eq $JOB2 -and $ids[1] -eq $JOB1) { "OK" } else { "BAD $($ids -join ',')" }
  } catch { $t11ok = "BAD" }
  check "T11b newest analysis first (job2, then job1)" "OK" $t11ok

  # T12: missing result file -> 410, and NOTHING is written
  Move-Item (Join-Path $ResultsDir "$JOB1.json") (Join-Path $ResultsDir "$JOB1.json.bak") -Force
  $c = Invoke-Api "POST" "/api/autocut/decisions" "T12" $AUTH_A "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-1\",\"decision\":\"APPROVE\"}"
  check "T12 missing result file -> failed write is NOT silent success (410)" "410" $c
  $rows2 = (exec $BunExe run $qJs $DbPath "SELECT COUNT(*) FROM CutDecision") | Select-Object -First 1
  check "T12b no row written on failed validation" "3" "$rows2"
  Move-Item (Join-Path $ResultsDir "$JOB1.json.bak") (Join-Path $ResultsDir "$JOB1.json") -Force

  # ============================ 4. export union ========================================
  note "export consumes only approved intervals"
  # Restored client state: sil-1=REVIEW(rejected), sil-2=REMOVE(approved), word-1=KEEP.
  # The apply union therefore contains ONLY sil-2 = [1.0,1.5).
  $c = Invoke-Api "POST" "/api/process/autocut" "T13" $AUTH_A "{\"mediaId\":\"$MEDIA_ID\",\"cuts\":[{\"start\":1.0,\"end\":1.5}],\"outputFormat\":\"wav\"}"
  check "T13 apply approved-only union accepted" "200" $c
  try {
    $t13 = Get-Content (Join-Path $Out "T13.body") -Raw | ConvertFrom-Json
    $applyJob = $t13.jobId; $est = $t13.estimatedFinalSec
  } catch { $applyJob = $null; $est = $null }
  check "T13b estimatedFinalSec = 3.0 - 0.5" "2.5" "$est"
  $final = "FAILED"; $exportId = ""
  for ($i = 1; $i -le 60; $i++) {
    $null = Invoke-Api "GET" "/api/jobs/$applyJob" "T13p" $AUTH_A $null
    try {
      $jp = Get-Content (Join-Path $Out "T13p.body") -Raw | ConvertFrom-Json
      $jst = $jp.job.status; $jexp = $jp.job.exportId
    } catch { $jst = ""; $jexp = "" }
    if ("$jst" -eq "COMPLETED") { $final = "OK exportId=$jexp"; $exportId = $jexp; break }
    if ("$jst" -eq "FAILED")    { $final = "FAILED: $jst"; break }
    Start-Sleep -Seconds 1
  }
  Write-Host "apply job: $final"
  Set-Content -Path (Join-Path $Out "apply_result.txt") -Value "apply job: $final" -Encoding ASCII
  check-contains "T13c apply job completed" "OK exportId=" (Join-Path $Out "apply_result.txt")
  $c = Invoke-Api "GET" "/api/exports/$exportId/file" "T13d" $AUTH_A $null
  check "T13d export downloads" "200" $c
  $dur = exec ffprobe -v error -show_entries format=duration -of csv=p=0 (Join-Path $Out "T13d.body")
  $dur = "$dur" | Select-Object -First 1
  note "export duration: $dur (expect ~2.5)"
  $t13e = $false
  try { $t13e = ([math]::Abs(([double]("$dur")) - 2.5) -lt 0.05) } catch { $t13e = $false }
  if ($t13e) { Write-Host "PASS  T13e export duration ~ 2.5s (only approved interval removed)"; $script:Pass++ }
  else { Write-Host "FAIL  T13e export duration $dur"; $script:Fail++ }
  $c = Invoke-Api "POST" "/api/process/autocut" "T14" $AUTH_A "{\"mediaId\":\"$MEDIA_ID\",\"cuts\":[{\"start\":0.2,\"end\":1.0},{\"start\":0.5,\"end\":1.5}],\"outputFormat\":\"wav\"}"
  check "T14 overlapping raw cuts rejected server-side (client union is the fix)" "400" $c

  # ============================ 5. integrity ===========================================
  $FixtureShaAfter = (Get-FileHash -Algorithm SHA256 $FixturePath).Hash.ToLower()
  check "T15 fixture media SHA-256 unchanged" "$FixtureShaBefore" "$FixtureShaAfter"
  $code = Invoke-Api "GET" "/api/autocut/decisions?jobId=$JOB1" "T16" $null $null
  check "T16 unauthenticated decisions GET rejected" "401" $code

  # ============================ done ===================================================
} finally {
  Write-Host "----------------------------------------"
  Write-Host "E2E RESULTS: PASS=$($script:Pass) FAIL=$($script:Fail)"
  if ($script:PathsValidated) {
    try {
      New-Item -ItemType Directory -Path $Out -Force | Out-Null
      Set-Content -Path (Join-Path $Out "summary.txt") -Value "$($script:Pass) $($script:Fail)" -Encoding ASCII
    } catch { }
  }
  Stop-TestServer
  note "isolated server stopped (artifacts preserved in .p3-test\outputs)"
}

if ($script:Fail -ne 0) { exit 1 }
exit 0

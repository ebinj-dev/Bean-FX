#!/bin/bash
# P3 reconciliation package — finalizer + Phase E verification.
# 1) SHA256SUMS.txt for every packaged file (excluding itself)
# 2) BEAN-FX-P3-TRANSFER.zip
# 3) verification: zip integrity test, fresh extraction, hash re-check,
#    forbidden-content scan, file-count parity
set -euo pipefail

PKG=/home/z/my-project/download/P3-RECONCILIATION-PACKAGE
ZIP=/home/z/my-project/download/BEAN-FX-P3-TRANSFER.zip
VER=/tmp/p3verify

cd "$PKG"

# ---- 1. SHA-256 manifest (self-excluded) --------------------------------
find . -type f ! -name SHA256SUMS.txt | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS.txt
echo "== SHA256SUMS.txt: $(wc -l < SHA256SUMS.txt) entries =="

# ---- 2. zip --------------------------------------------------------------
rm -f "$ZIP"
cd /home/z/my-project/download
python3 - <<'EOF'
import os, zipfile
root = "P3-RECONCILIATION-PACKAGE"
with zipfile.ZipFile("BEAN-FX-P3-TRANSFER.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            z.write(p, p)
print("zip written")
EOF

# ---- 3. verification -----------------------------------------------------
echo "== zip integrity test =="
python3 -c "
import zipfile
z = zipfile.ZipFile('$ZIP')
bad = z.testzip()
print('testzip:', 'FAILED at ' + bad if bad else 'OK')
print('entries in zip:', len(z.namelist()))
"

echo "== fresh extraction + hash re-check =="
rm -rf "$VER" && mkdir -p "$VER"
cd "$VER"
python3 -c "import zipfile; zipfile.ZipFile('$ZIP').extractall('.')"
cd "$VER/P3-RECONCILIATION-PACKAGE"
sha256sum -c SHA256SUMS.txt | tee "$VER/hashcheck.txt" | grep -c ": OK$" | xargs -I{} echo "files matching manifest: {}"
grep -v ": OK$" "$VER/hashcheck.txt" && echo "!! hash mismatches found" || echo "no hash mismatches"

echo "== file-count parity (package dir vs zip vs manifest) =="
N_DIR=$(find . -type f | wc -l)
N_MAN=$(wc -l < SHA256SUMS.txt)
N_ZIP=$(python3 -c "import zipfile;print(len(zipfile.ZipFile('$ZIP').namelist()))")
echo "package files=$N_DIR  manifest entries=$N_MAN  zip entries=$N_ZIP (zip has 1 extra dir entry expected)" || true

echo "== forbidden-content scan (must print nothing but the headers) =="
echo "-- live db / media / env / node_modules / .git inside package:"
find "$PKG" -name "*.db" -o -name "*.sqlite*" -o -name ".env" -o -name "node_modules" -o -name ".git" -o -path "*media-store*" | grep -v "^$" || echo "  CLEAN"
python3 -c "
import zipfile
z = zipfile.ZipFile('$ZIP')
hits = [n for n in z.namelist() if n.endswith(('.db','.sqlite','.sqlite3','.env')) or 'media-store' in n or 'node_modules' in n or '/.git/' in n]
print('-- inside zip:', hits if hits else 'CLEAN')
"
echo "-- no absolute /home/z paths inside application source files:"
if grep -rl "/home/z/my-project" "$PKG/source" "$PKG/migration" 2>/dev/null; then echo "  ^^ FOUND (unexpected)"; else echo "  CLEAN"; fi

echo "== zip info =="
ls -la "$ZIP" | awk '{print $5" bytes"}'
sha256sum "$ZIP"

#!/usr/bin/env bash
# run-deploy.sh — publish the site from the VPS, the job pages.yml used to do.
#
# pages.yml is still in the repo and still works, but it only runs when GitHub
# Actions runs, and on 2026-09-30 the account was locked for billing and every
# workflow stopped starting. The poll moved to this box the same day; without
# this, the poll pushed fresh listings to main and explora.city went on
# serving 2026-09-27 because the deploy half was still on Actions.
#
# It reproduces pages.yml exactly, in the same order:
#   1. node scripts/build-seo.mjs   — the crawlable counterparts
#   2. sed ?v=dev -> the commit sha  — the cache bust
#   3. publish the repository as-is  — there is no build step
#
# Releases are built beside the live tree and swapped in by moving a symlink,
# which is one rename syscall: nobody is ever served a half-written site. The
# previous releases stay on disk, so a bad deploy is `ln -sfn` back.
#
#   run-deploy.sh           # deploy if main moved
#   FORCE=1 run-deploy.sh   # deploy even if it did not
set -euo pipefail

EXPLORA=/opt/Explora
WEB=/var/www/explora
LOCK="$EXPLORA/.git/explora-lane.lock"
KEEP=5

cd "$EXPLORA"
flock -w 600 "$LOCK" git pull --quiet --ff-only origin main

SHA=$(git rev-parse HEAD)
SHORT=${SHA:0:7}
LIVE=$(basename "$(readlink -f "$WEB/current" 2>/dev/null || echo none)")

if [ "$LIVE" = "$SHA" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "already serving ${SHORT}"
  exit 0
fi

REL="$WEB/releases/$SHA"
rm -rf "$REL"
mkdir -p "$REL"

# The repository *is* the artifact — pages.yml uploads it with `path: .` and
# no build. These are the parts that are not the site: the poller and its
# fixtures, the build scripts, this directory, and the working notes. Nothing
# in index.html or app.js references any of them (checked), and leaving them
# out means the sources file and the handover are not served to the public.
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='node_modules/' \
  --exclude='scrape/' \
  --exclude='scripts/' \
  --exclude='scripts-vps/' \
  --exclude='.gitignore' \
  --exclude='README.md' \
  --exclude='HANDOVER.md' \
  --exclude='EVENTBRITE-FINDINGS.md' \
  --exclude='package.json' \
  --exclude='package-lock.json' \
  --exclude='_*' \
  "$EXPLORA/" "$REL/"

# build-seo.mjs resolves everything from process.cwd(), so running it here
# writes the generated files into the release and leaves the checkout clean.
# That matters: run-poll.sh pulls --ff-only, and a working tree dirtied by a
# deploy would wedge it. It needs no node_modules — only fs, vm and path.
( cd "$REL" && node "$EXPLORA/scripts/build-seo.mjs" )

# Without this a browser can hold a fresh index.html beside a cached older
# app.js, and that pairing throws inside the click handler: the page renders
# and nothing responds, with no visible clue why.
sed -i "s/?v=dev/?v=${SHORT}/g" "$REL/index.html" "$REL/listings.html"

# Fail before the swap rather than publishing a site that is subtly broken.
grep -q "app.js?v=${SHORT}" "$REL/index.html" || { echo "cache bust did not apply" >&2; exit 1; }
grep -q 'application/ld+json' "$REL/index.html"  || { echo "build-seo wrote no JSON-LD" >&2; exit 1; }
test -s "$REL/sitemap.xml" || { echo "no sitemap" >&2; exit 1; }

# One rename. ln -sfn alone would not do: with an existing symlink to a
# directory it creates the link *inside* the target instead of replacing it.
ln -sfn "$REL" "$WEB/.current.tmp"
mv -Tf "$WEB/.current.tmp" "$WEB/current"

# Keep a few to roll back to, drop the rest.
# shellcheck disable=SC2012
ls -1dt "$WEB/releases/"*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf

echo "deployed ${SHORT} ($(find "$REL" -type f | wc -l) files)"

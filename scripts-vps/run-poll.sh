#!/usr/bin/env bash
# run-poll.sh — the daily source poll, run from the VPS.
#
# Replaces the "Poll the sources" lane in .github/workflows/scrape.yml. Two
# reasons, and only one of them is cost:
#
#   1. The GitHub account was locked for billing on 2026-09-30 and every run
#      since died in 3-4 seconds with "The job was not started because your
#      account is locked due to a billing issue" — zero steps, no log, no
#      notification. A systemd timer on a box we pay for cannot fail that way.
#   2. Scheduled workflows run late. scrape.yml's own comment records 11:17
#      UTC nominal firing at 15:07; the content lanes saw 2h08m to 5h18m.
#
# It did not fix Eventbrite either, and for a while this comment said that
# was the end of it — the 405 follows the datacenter IP, so the VPS gets it
# exactly as the runner did. What actually fixed it was reading a different
# page: only /d/ search is walled, and /ttd/ answers. See sources.mjs.
#
# Kept as a script rather than inlined into the unit so it can be run by hand
# exactly as the timer runs it:  run-poll.sh --dry-run
set -euo pipefail

EXPLORA=/opt/Explora
LOCK="$EXPLORA/.git/explora-lane.lock"

# ANTHROPIC_API_KEY. Without it run.mjs reports model-read pages as skipped
# rather than failing, but comedybar and evergreen then publish nothing and
# the went-quiet guard refuses to write scraped.js at all — which is exactly
# how the 2026-09-28 run died when the Anthropic balance hit zero.
set -a
# shellcheck disable=SC1091
[ -f /etc/explora/poll.env ] && . /etc/explora/poll.env
set +a

cd "$EXPLORA"

# Current before anything runs. ff-only: this checkout is never authored on
# except by this script, so a divergence is a problem to look at rather than
# something to rebase past silently.
flock -w 600 "$LOCK" git pull --quiet --ff-only origin main

# Only when the lockfile actually moved. npm ci wipes and rebuilds
# node_modules, which is ~40s we do not need on a day nothing changed.
STAMP=.git/npm-ci-stamp
if [ ! -f "$STAMP" ] || ! sha256sum -c --status "$STAMP" 2>/dev/null; then
  echo "--- npm ci (lockfile changed) ---"
  npm ci --no-audit --no-fund
  sha256sum package-lock.json > "$STAMP"
  # Playwright pins a browser build per version, and a lockfile bump moves it.
  # 1.63 wanted chromium-1243 where this box had 1208 from another project,
  # and the only symptom was "Executable doesn't exist at ...".
  npx playwright install chromium
fi

# The offline suite first: if the extractors are broken, find out before
# hitting anyone's servers. This is the one step allowed to abort the run.
#
# `npm test`, not `node scrape/test.mjs`: #68 made the script
# `test.mjs && test-eventbrite.mjs`, and calling the file directly would skip
# the Eventbrite suite without saying so.
echo "--- extractors (offline) ---"
npm test

echo "--- poll ---"
node scrape/run.mjs "$@"

# The three read-overs. Each prints what a person should look at, and none of
# them may stop the run: a thin description is sometimes the honest answer,
# and a missing street festival is a suggestion rather than a defect.
for audit in \
  scripts/audit-descriptions.mjs \
  scripts/audit-schedules.mjs \
  scripts/propose-street-events.mjs
do
  echo "--- ${audit##*/} ---"
  node "$audit" || echo "(${audit##*/} exited $? — not fatal)"
done

# The poll only ever discovers new events; this fills prices on the
# hand-written listings that have none. Also not fatal: a failed lookup leaves
# the listing as it was, which is the safe direction.
echo "--- price recheck ---"
node scrape/recheck.mjs || echo "(recheck exited $? — not fatal)"

# Descriptions for the listings whose source wrote none, on the Batch API.
#
# Two phases a day apart, which is why this is one line and not two: it
# collects the batch submitted last night and submits tonight's in the same
# run. The poll above has already read every page and left the text in
# scrape/descriptions.json, so nothing here fetches anything.
#
# A day's lag on a description is the trade for half price, and it is a good
# trade — the listing is already on the board, correct, just thin. Not fatal
# either: a batch that has not finished is simply collected tomorrow.
echo "--- descriptions ---"
node scripts/write-descriptions.mjs --recover || echo "(write-descriptions exited $? — not fatal)"

# price-attempts.json belongs in this list: it is the recheck's memory of
# which pages have already answered "no price". Left uncommitted, every
# listing is asked again next run and the backoff silently does nothing.
# descriptions.json belongs here for the same reason price-attempts.json
# does: it is the memory of what has been written and what has been read and
# found to say nothing. Left uncommitted it is rebuilt from zero every run,
# every page is asked about again, and the batch bill repeats nightly.
FILES='scraped.js data.js scrape/price-attempts.json scrape/descriptions.json'

if [ -z "$(git status --porcelain -- $FILES)" ]; then
  echo "nothing changed"
  exit 0
fi

git --no-pager diff --stat -- $FILES

if [ "${POLL_DRY_RUN:-0}" = "1" ]; then
  echo "POLL_DRY_RUN=1 — not committing"
  exit 0
fi

# Straight to main, where the Actions lane opened a pull request.
#
# That gate had stopped working long before the billing lock: nine poll PRs
# were open and unmerged on 2026-10-03, the oldest from 2026-09-13, so in
# practice nobody reviewed them and the board just went stale. The guards that
# do the real work run here either way — the went-quiet check that refuses to
# write a scraped.js missing a source's listings, the $35 ceiling, the three
# audits above. `git log -p scraped.js` is the review, after the fact.
#
# No [skip ci]: once Actions is unlocked, this push is what deploys the site.
# The commit is rolled back if the push does not land.
#
# Unattended, a failed push is worse than a lost poll: the commit stays, the
# checkout is a commit ahead of origin, and every subsequent run dies on the
# `--ff-only` pull at the top of this script. One bad day would become every
# day, silently, and the only symptom would be a stale board again. Throwing
# the commit away costs one day's poll, which tomorrow redoes from scratch.
BEFORE=$(git rev-parse HEAD)

if flock -w 600 "$LOCK" bash -s -- $FILES <<'INNER'
set -euo pipefail
git add -- "$@"
git -c user.name=vps-bot -c user.email=vps-bot@users.noreply.github.com \
    commit -q -m "Polled event sources on $(date -u +%Y-%m-%d)"

# Rebase and retry before giving up. A poll takes fifteen minutes and main
# moves during it: on 2026-10-03 a push from a laptop landed mid-run, this
# push was rejected as non-fast-forward, and the rollback below threw away a
# good poll — along with the descriptions.json entry recording a batch that
# had ALREADY been submitted, orphaning it. Paid for, uncollectable, and the
# next run would have submitted the same questions again.
#
# A rejected push here is almost always that: someone else got there first,
# and the fix is one rebase. Only when the retry fails too is it a real
# problem worth losing the run over.
if ! git push --quiet origin HEAD:main 2>/dev/null; then
  echo "push rejected — rebasing onto origin/main and retrying" >&2
  git -c user.name=vps-bot -c user.email=vps-bot@users.noreply.github.com \
      pull --rebase --quiet origin main
  git push --quiet origin HEAD:main
fi
INNER
then
  echo "pushed"
else
  status=$?
  echo "push failed (exit ${status}) — rolling back to ${BEFORE:0:7} so tomorrow's pull still fast-forwards" >&2
  git reset --hard --quiet "$BEFORE"
  exit "$status"
fi

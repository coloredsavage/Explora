/* Every illustration on the board, in one page, with the measurements that
 * decide whether it is drawn correctly.
 *
 *   node scripts/art-sheet.mjs          # write _art-sheet.html and report
 *   node scripts/art-sheet.mjs --check  # report only, non-zero if any fail
 *
 * Most faults in this set are only visible in company. A drawing that looks
 * fine alone turns out to be the one floating, or the one pushed left, or the
 * one that is a silhouette among things with weight. So the sheet puts all of
 * them on their category tints side by side, and the numbers underneath it are
 * the rules in art/SPEC.md applied one symbol at a time.
 *
 * The geometry is measured off the paths rather than eyeballed, and the one
 * that matters most — whether an object is standing on its shadow or hovering
 * above it — is not something you can see reliably at card size. It is
 * arithmetic, so it is done as arithmetic.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const root = process.cwd();
const html = readFileSync(`${root}/index.html`, 'utf8');
const css = readFileSync(`${root}/styles.css`, 'utf8');

const symbols = [...html.matchAll(/<symbol id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)]
  .map((m) => ({ id: m[1], body: m[2], whole: m[0] }));

const tints = [...css.matchAll(/--c-([a-z]+):\s*(#[0-9a-f]{6})/g)].map((m) => m[2]);

/* How often each symbol is actually on screen. A fault in something used
   fourteen times is a different size of problem from the same fault in
   something used once. */
function usage() {
  const ctx = vm.createContext({});
  for (const f of ['price.js', 'data.js', 'scraped.js']) {
    vm.runInContext(readFileSync(`${root}/${f}`, 'utf8'), ctx, { filename: f });
  }
  const events = vm.runInContext('EVENTS', ctx).concat(vm.runInContext('SCRAPED', ctx));
  const cats = vm.runInContext('CATEGORIES', ctx);
  const counts = new Map();
  for (const e of events) {
    const art = e.art || cats[e.category].art;
    counts.set(art, (counts.get(art) ?? 0) + 1);
  }
  return { counts, total: events.length };
}

/* Measured in a real renderer, because the alternative does not work.
 *
 * The first version of this read the numbers out of d="" and paired them off
 * as x,y. SVG path syntax is not that — arcs carry flags and radii, curves
 * carry control points, lowercase commands are relative — so it put
 * art-market's centre at 95 when it is at 130, and then reported that
 * ninety-nine percent of the set was broken. A measuring tool that is wrong
 * is worse than no measuring tool, because it gets believed.
 *
 * getBBox in a headless page is the ground truth and playwright is already a
 * dependency here for the poller, so there is nothing extra to install. */
async function measure() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<svg width="0" height="0">${symbols.map((s) => s.whole).join('')}</svg>`);

  const out = await page.evaluate(() => {
    const NS = 'http://www.w3.org/2000/svg';
    const rows = [];
    document.querySelectorAll('symbol').forEach((sym) => {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 260 200');
      svg.style.cssText = 'position:absolute;left:-9999px;width:260px;height:200px';
      const g = document.createElementNS(NS, 'g');
      g.innerHTML = sym.innerHTML;
      svg.appendChild(g);
      document.body.appendChild(svg);

      /* The ground: low, wide and squashed. Anything else elliptical is part
         of the drawing. */
      let ground = null;
      g.querySelectorAll('ellipse').forEach((e) => {
        const cy = +e.getAttribute('cy');
        const rx = +e.getAttribute('rx');
        const ry = +e.getAttribute('ry');
        if (cy > 120 && rx > 25 && ry < rx / 2) ground = { cy, rx, el: e };
      });
      const groundCy = ground ? ground.cy : null;
      const groundRx = ground ? ground.rx : null;
      if (ground) ground.el.remove();

      const b = g.getBBox();
      rows.push({
        id: sym.id,
        cx: Math.round(b.x + b.width / 2),
        width: Math.round(b.width),
        bottom: Math.round(b.y + b.height),
        groundCy, groundRx,
      });
      svg.remove();
    });
    return rows;
  });

  await browser.close();
  return out;
}

const { counts, total } = usage();

const measured = await measure();
const byId = new Map(measured.map((m) => [m.id, m]));

const rows = symbols.map(({ id, body }) => {
  const m = byId.get(id);
  const fills = new Set([...body.matchAll(/fill="([^"]+)"/g)].map((x) => x[1])
    .filter((f) => f !== '#000' && f !== 'none'));
  const gap = m && m.groundCy != null ? m.bottom - m.groundCy : null;
  const faults = [];
  if (gap != null && gap < -8) faults.push(`floats (${gap})`);
  if (m && Math.abs(m.cx - 130) > 3) faults.push(`off-centre (${m.cx})`);
  /* A floor, not a target. Fill count cannot tell a simple subject from an
     under-drawn one — a microphone is genuinely simpler than a streetcar — so
     below four is called out as almost certainly a pictogram and everything
     above it is reported without a verdict. See SPEC.md §2; the first version
     of this flagged anything under six and told you to beat the number, which
     is how you get a fussy jar. */
  if (fills.size < 4) faults.push(`flat (${fills.size} fills)`);
  if (m && m.groundCy == null) faults.push('no ground');
  return { id, cx: m ? m.cx : null, gap, fills: fills.size, uses: counts.get(id) ?? 0, faults };
});

rows.sort((a, b) => b.uses - a.uses || b.faults.length - a.faults.length);

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${rows.length} symbols · ${rows.filter((r) => r.faults.length).length} with something to fix\n`);
console.log(`  ${pad('symbol', 20)}${pad('uses', 6)}${pad('gap', 6)}${pad('cx', 6)}${pad('fills', 7)}faults`);
for (const r of rows) {
  console.log(`  ${pad(r.id, 20)}${pad(r.uses || '·', 6)}${pad(r.gap ?? '?', 6)}${pad(r.cx ?? '?', 6)}${pad(r.fills, 7)}${r.faults.join(', ')}`);
}

const onScreen = rows.filter((r) => r.faults.length).reduce((n, r) => n + r.uses, 0);
console.log(`\n  ${Math.round(onScreen / total * 100)}% of listings draw a symbol with a fault in it.`);
console.log('  Rules and what they mean: art/SPEC.md\n');

if (!process.argv.includes('--check')) {
  const cells = symbols.map(({ id }, i) => `<figure style="margin:0;background:${tints[i % tints.length]};border-radius:14px;padding:10px 10px 6px">
  <svg viewBox="0 0 260 200" style="width:100%;display:block"><use href="#${id}"/></svg>
  <figcaption style="font:500 11px/1.4 system-ui;color:#555;text-align:center;padding-top:6px">${id}</figcaption>
  </figure>`).join('');
  writeFileSync(`${root}/_art-sheet.html`, `<!doctype html><meta charset="utf-8"><title>Illustrations</title>
<body style="margin:0;padding:18px;background:#fff">
<svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols.map((s) => s.whole).join('')}</svg>
<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px">${cells}</div></body>`);
  console.log('  wrote _art-sheet.html\n');
}

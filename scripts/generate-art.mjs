#!/usr/bin/env node
/* Generate one illustration per event and wire it into data.js.
 *
 *   OPENAI_API_KEY=sk-...   node scripts/generate-art.mjs
 *   REPLICATE_API_TOKEN=... node scripts/generate-art.mjs --provider replicate
 *
 * Flags
 *   --provider openai|replicate   default openai
 *   --model <id>                  override the model
 *   --only <event-id>             regenerate a single event (repeatable)
 *   --size 1024x1024              square sizes only
 *   --force                       overwrite files that already exist
 *   --dry-run                     print the prompts and exit, no API calls
 *
 * Images land in art/<event-id>.png and each event gains an `image:` field.
 * Events without an image fall back to the SVG object drawn in index.html, so
 * a partial run is fine — the page stays consistent either way.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artDir = path.join(root, 'art');
const dataFile = path.join(root, 'data.js');

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { provider: 'openai', size: '1024x1024', only: [], force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--size') out.size = argv[++i];
    else if (a === '--only') out.only.push(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else { console.error(`unknown flag: ${a}`); process.exit(1); }
  }
  return out;
}

const HELP = `usage: node scripts/generate-art.mjs [options]

  --provider openai|replicate   default openai
  --model <id>                  override the default model
  --only <event-id>             one event; repeatable
  --size 1024x1024              square sizes only
  --force                       overwrite existing files
  --dry-run                     print prompts, make no API calls`;

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------- providers */

const providers = {
  async openai(prompt, { model = 'gpt-image-1', size }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt, size, n: 1, background: 'transparent' }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 400)}`);

    const json = await res.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) throw new Error('openai returned no image data');
    return Buffer.from(b64, 'base64');
  },

  async replicate(prompt, { model = 'black-forest-labs/flux-schnell' }) {
    const key = process.env.REPLICATE_API_TOKEN;
    if (!key) throw new Error('REPLICATE_API_TOKEN is not set');

    const start = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        prefer: 'wait',
      },
      body: JSON.stringify({ input: { prompt, aspect_ratio: '1:1', output_format: 'png' } }),
    });
    if (!start.ok) throw new Error(`replicate ${start.status}: ${(await start.text()).slice(0, 400)}`);

    let pred = await start.json();
    /* `prefer: wait` usually returns a finished prediction; poll if it did not */
    while (pred.status === 'starting' || pred.status === 'processing') {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(pred.urls.get, { headers: { authorization: `Bearer ${key}` } });
      pred = await poll.json();
    }
    if (pred.status !== 'succeeded') throw new Error(`replicate ${pred.status}: ${pred.error ?? ''}`);

    const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    const img = await fetch(url);
    if (!img.ok) throw new Error(`fetching output: ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  },
};

/* ----------------------------------------------------------------- main */

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  const generate = providers[args.provider];
  if (!generate) throw new Error(`unknown provider: ${args.provider}`);

  const { style, subjects } = JSON.parse(await readFile(path.join(artDir, 'prompts.json'), 'utf8'));
  let data = await readFile(dataFile, 'utf8');

  let ids = Object.keys(subjects);
  if (args.only.length) {
    const unknown = args.only.filter((id) => !subjects[id]);
    if (unknown.length) throw new Error(`no prompt for: ${unknown.join(', ')}`);
    ids = args.only;
  }

  await mkdir(artDir, { recursive: true });

  const done = [];
  for (const id of ids) {
    const prompt = style.replace('{subject}', subjects[id]);
    const file = path.join(artDir, `${id}.png`);

    if (args.dryRun) {
      console.log(`\n── ${id}\n${prompt}`);
      done.push(id);
      continue;
    }
    if (!args.force && (await exists(file))) {
      console.log(`skip  ${id} (already drawn — pass --force to redo)`);
      done.push(id);
      continue;
    }

    process.stdout.write(`draw  ${id} … `);
    try {
      await writeFile(file, await generate(prompt, { model: args.model, size: args.size }));
      console.log('ok');
      done.push(id);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  if (args.dryRun) return;

  /* point each event at its file; events we could not draw keep the SVG */
  let added = 0;
  for (const id of done) {
    if (!(await exists(path.join(artDir, `${id}.png`)))) continue;

    const block = new RegExp(`(id: '${id}',[\\s\\S]{0,400}?\\n(\\s*)art: '[^']*',)`);
    const m = data.match(block);
    if (!m) { console.warn(`warn  ${id}: no art field found in data.js`); continue; }
    if (data.slice(m.index, m.index + 600).includes(`image: 'art/${id}.png'`)) continue;

    data = data.slice(0, m.index + m[1].length) +
           `\n${m[2]}image: 'art/${id}.png',` +
           data.slice(m.index + m[1].length);
    added++;
  }

  if (added) {
    await writeFile(dataFile, data);
    console.log(`\nwired ${added} image${added === 1 ? '' : 's'} into data.js`);
  } else {
    console.log('\nno data.js changes needed');
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });

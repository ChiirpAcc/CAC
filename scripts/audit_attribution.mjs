// The attribution audit (ATTRIBUTION.md, section 7), run against the data in
// data/ with the site's own code, so the page and this check can never use
// different rules. Exits 1 when a rule and a figure disagree.
//
//   node scripts/audit_attribution.mjs            prints the checks
//   node scripts/audit_attribution.mjs --md FILE  also appends them to FILE
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The site fetches data/*.json; here the same paths are read from disk.
globalThis.fetch = async url => {
  const text = await readFile(path.join(root, String(url).replace(/^\.?\//, '')), 'utf-8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text), body: null };
};

const site = await import(pathToFileURL(path.join(root, 'site', 'data.js')).href);
const data = await site.load();
const audit = site.attributionAudit(data);

const lines = [`## Attribution audit: ${audit.passed} of ${audit.checks.length} checks pass`, ''];
for (const c of audit.checks) {
  lines.push(`- ${c.pass ? 'PASS' : '**FAIL**'} \`${c.id}\` ${c.rule}`
    + (c.pass ? '' : ` (${c.count}): ${c.failures.join('; ')}${c.count > c.failures.length ? '; ...' : ''}`));
}
const text = lines.join('\n');
console.log(text);

const i = process.argv.indexOf('--md');
if (i > -1 && process.argv[i + 1]) await appendFile(process.argv[i + 1], `\n\n${text}\n`);
process.exit(audit.failed ? 1 : 0);

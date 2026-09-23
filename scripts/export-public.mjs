// Export this repository as a fresh, history-free repository for publishing.
//
// The working tree is generic, but this repository's HISTORY is not: unpublished
// material lived in it before the site-extension split, and history cannot be
// made public by deleting files. So the public repository is an export: the
// tracked files of one commit, copied, checked, and committed once on a new
// history. Re-run it to publish a newer state.
//
//   node scripts/export-public.mjs --out ../seqbrowser-public \
//        [--forbidden-file <path>] [--exclude <glob-prefix>]... [--build]
//
// --forbidden-file  one word or phrase per line; the export fails if any tracked
//                   file's PATH or TEXT contains one (case-insensitive, and only
//                   at a word start, so a word inside a longer word does not
//                   trip it). Kept OUTSIDE this repository, since the words are
//                   the secret -- this file must not name them either.
// --exclude         a path prefix to leave out (repeatable). Always left out:
//                   design/ (internal notes and build logs); the deploy of
//                   THIS installation -- wrangler configs and the access gate
//                   -- which name hostnames and Workers that are not the
//                   export's to deploy to; and the tests that need the dev
//                   extension's models, which the export does not carry (see
//                   EXTENSION_TESTS). Its README is swapped for
//                   README.public.md, written for whoever clones the export.
// --build           also run `npm ci && npm run build` in the export, which
//                   proves it stands on its own.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALWAYS_EXCLUDED = [
  'design/',
  'wrangler.toml',
  'wrangler.dev.toml',
  'worker/',
  // The gate's test goes with the gate: it imports it.
  'src/test/dev-gate.test.ts',
  'README.public.md',
];
// Scripts that only make sense against this installation's Cloudflare account.
const DEPLOY_SCRIPTS = ['deploy', 'deploy:dev', 'build:dev'];

// Tests that run against a model the dev extension supplies (a toy that
// exercises ISM rows, checkpoint families and the probability axis). The
// export has no extension, so it has no such model, so these cannot run there.
// They live in the models repository's suite as well.
const EXTENSION_TESTS = [
  'src/test/catalog-order.test.ts',
  'src/test/site-profile.test.ts',
  'src/test/models-panel.test.tsx',
  'src/test/subtrack-scale-shapes.test.ts',
  'src/test/app-integration-controls.test.tsx',
  'tests/e2e/ism-hover.spec.ts',
  'tests/e2e/ism-progressive.spec.ts',
  'tests/e2e/scale-shape.spec.ts',
  'tests/e2e/track-grouping.spec.ts',
  'tests/e2e/track-groups.spec.ts',
];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|toml|yml|yaml|html|css|txt|py|sh|czpack|_headers|gitignore)$/i;

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const out = resolve(option('--out') ?? '../seqbrowser-public');
const forbiddenFile = option('--forbidden-file');
const excludes = [...ALWAYS_EXCLUDED, ...EXTENSION_TESTS];
args.forEach((arg, index) => {
  if (arg === '--exclude' && args[index + 1]) excludes.push(args[index + 1]);
});
const build = args.includes('--build');

const forbidden = forbiddenFile
  ? readFileSync(forbiddenFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  : [];
const matchers = forbidden.map((word) => ({
  word,
  re: new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
}));

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO })
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter((file) => !excludes.some((prefix) => file.startsWith(prefix)));

const problems = [];
for (const file of tracked) {
  for (const { word, re } of matchers) {
    if (re.test(file)) problems.push(`${file}: path contains "${word}"`);
  }
  if (TEXT.test(file) || !file.includes('.')) {
    const text = readFileSync(join(REPO, file), 'latin1');
    for (const { word, re } of matchers) {
      if (re.test(text)) {
        const line = text.split('\n').findIndex((row) => re.test(row)) + 1;
        problems.push(`${file}:${line}: text contains "${word}"`);
      }
    }
  }
}
if (problems.length > 0) {
  console.error('Not exported. The tree is not clean:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let bytes = 0;
for (const file of tracked) {
  const target = join(out, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(REPO, file), target);
  bytes += statSync(target).size;
}

// The export's own README, and a package.json without this installation's
// deploy scripts (their configs are not exported, so they could only fail).
const publicReadme = join(REPO, 'README.public.md');
if (existsSync(publicReadme)) cpSync(publicReadme, join(out, 'README.md'));
const pkgPath = join(out, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
for (const name of DEPLOY_SCRIPTS) delete pkg.scripts[name];
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const git = (...cmd) => execFileSync('git', cmd, { cwd: out, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=Sequence Browser', '-c', 'user.email=noreply@zhoulab.io', 'commit', '-q', '-m', 'Sequence Browser hackathon build');
console.log(`  exported ${tracked.length} files (${(bytes / 1048576).toFixed(1)} MiB) to ${out}`);
console.log(`  one commit on a new history: ${git('rev-parse', '--short', 'HEAD')}`);
console.log(`  checked ${forbidden.length} forbidden word(s); excluded ${excludes.join(', ')}`);

if (build) {
  console.log('  building the export on its own...');
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: out, stdio: 'inherit' });
  console.log('  the export builds.');
}

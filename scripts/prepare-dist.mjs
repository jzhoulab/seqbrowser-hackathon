// Prune dist/ down to what the deployed site actually fetches, then refuse to
// continue if anything that should not ship survived.
//
// Two things put weight in dist/ that nobody downloads. Vite copies everything
// under public/ verbatim, so local-only sample data rides along; and Rollup emits
// its own hashed copy of the ONNX runtime binary because the module references
// it as an asset URL, even though the worker pins `wasmPaths` to the unhashed
// copy under /ort/ and never asks for the hashed one.
//
// Nothing here is about keeping unpublished material out of a build: that is
// done by not having any in this repository. A product with unpublished models
// supplies them through a site extension (src/features/site/extension.ts), and a
// build made without one has nothing to prune.
//
// Only dist/ is touched: public/ is left alone so dev and e2e keep whatever local
// copies they have.
//
//   node scripts/prepare-dist.mjs [--max-file-bytes=N]
//
// `--max-file-bytes` fails the build if any single file exceeds N. Cloudflare
// Pages rejects uploads over 25 MiB, so `build:pages` passes it; a plain build
// does not, since other hosts have no such limit.
import { readdir, stat, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// Paths that exist in public/ for local development but are not part of the
// deployed site. Each needs a reason, so this list does not rot into a mystery.
const NOT_SHIPPED = [
  // hg19 builds of the demo signal tracks, superseded by the hg38 URLs in
  // src/features/genome/demoData.ts. Gitignored, so absent on a clean checkout.
  'data/ucsc/wgEncodeBroadHistoneGm12878H3k27acStdSig.bigWig',
  'data/ucsc/wgEncodeBroadHistoneGm12878H3k4me3StdSig.bigWig',
];

// Files Rollup emits that the app never requests. Matched by pattern because
// the bundler hashes the name.
const UNREQUESTED = [
  // The worker sets ort.env.wasm.wasmPaths to /ort/ort-wasm-simd-threaded.wasm,
  // so this identical 12 MB copy is emitted and never fetched.
  /^assets\/ort-wasm-simd-threaded-[^/]+\.wasm$/,
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;

const maxFileArg = process.argv.find((arg) => arg.startsWith('--max-file-bytes='));
const maxFileBytes = maxFileArg ? Number(maxFileArg.split('=')[1]) : null;
if (maxFileArg && (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0)) {
  console.error(`Not a byte count: ${maxFileArg}`);
  process.exit(1);
}

let removed = 0;
const prune = async (rel) => {
  const { size } = await stat(join(DIST, rel));
  await rm(join(DIST, rel));
  removed += size;
  console.log(`  pruned  ${mib(size).padStart(10)}  ${rel}`);
};

for (const rel of NOT_SHIPPED) {
  try {
    await prune(rel);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Absent is fine: gitignored sample data is simply missing on a clean checkout.
  }
}

for await (const file of walk(DIST)) {
  const rel = relative(DIST, file);
  if (UNREQUESTED.some((pattern) => pattern.test(rel))) {
    await prune(rel);
  }
}

const oversized = [];
let total = 0;
let count = 0;
for await (const file of walk(DIST)) {
  const { size } = await stat(file);
  total += size;
  count += 1;
  if (maxFileBytes !== null && size > maxFileBytes) {
    oversized.push({ file: relative(DIST, file), size });
  }
}

console.log(`  pruned ${mib(removed)} total`);
console.log(`  dist now ${mib(total)} across ${count} files`);

if (oversized.length > 0) {
  console.error(`\nThis host rejects files over ${mib(maxFileBytes)}:`);
  for (const { file, size } of oversized) console.error(`  ${mib(size).padStart(10)}  ${file}`);
  console.error('\nAdd it to NOT_SHIPPED in scripts/prepare-dist.mjs, or host it elsewhere.');
  process.exit(1);
}

// Inspect an ONNX sequence model for .czpack authoring.
//
// Usage (from the repo root, so it resolves the project's onnxruntime-web):
//   node .claude/skills/czpack-author/inspect-onnx.mjs <path-to.onnx> [name=value ...]
//
// Prints input/output names and runs the model at two input lengths so you can
// read off how each output's length scales with input length. For a valid-conv
// model, flankBp = (inputLength - outputLength) / 2 (identical at both lengths).
// Extra `name=value` args are fed as scalar float inputs (e.g. threshold=8).

import { readFileSync } from 'node:fs';

const [, , modelPath, ...rest] = process.argv;
if (!modelPath) {
  console.error('usage: node inspect-onnx.mjs <path-to.onnx> [name=value ...]');
  process.exit(1);
}

const scalars = {};
for (const arg of rest) {
  const eq = arg.indexOf('=');
  if (eq > 0) {
    scalars[arg.slice(0, eq)] = Number(arg.slice(eq + 1));
  }
}

let ort;
try {
  ort = await import('onnxruntime-web');
} catch {
  console.error('Could not import onnxruntime-web. Run this from the seqbrowser repo root (npm install first).');
  process.exit(1);
}

ort.env.logLevel = 'error';
ort.env.wasm.numThreads = 1;

function oneHot(len) {
  // NCL one-hot, channel order A,C,G,T — matches the browser's encoder.
  const a = new Float32Array(4 * len);
  for (let i = 0; i < len; i += 1) a[(i % 4) * len + i] = 1;
  return a;
}

const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(modelPath)), {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});

const inputName = session.inputNames.find((n) => !(n in scalars)) ?? session.inputNames[0];
console.log('inputs :', session.inputNames.join(', '));
console.log('outputs:', session.outputNames.join(', '));
console.log('sequence input assumed:', inputName, '(shape [1, 4, L], one-hot A,C,G,T)');
if (Object.keys(scalars).length) console.log('fixed scalars:', JSON.stringify(scalars));

const lengths = [1024, 2048];
const outLen = {};
for (const L of lengths) {
  const feeds = { [inputName]: new ort.Tensor('float32', oneHot(L), [1, 4, L]) };
  for (const [name, value] of Object.entries(scalars)) {
    feeds[name] = new ort.Tensor('float32', new Float32Array([value]), [1]);
  }
  const out = await session.run(feeds);
  console.log(`\ninput L=${L}:`);
  for (const [name, tensor] of Object.entries(out)) {
    const pos = tensor.dims[tensor.dims.length - 1];
    console.log(`  ${name.padEnd(20)} dims=[${tensor.dims.join('x')}]  positionAxis=${pos}`);
    (outLen[name] ??= {})[L] = pos;
  }
}

console.log('\nflankBp estimate per output (valid-conv only; downsampling → use 0):');
for (const [name, byLen] of Object.entries(outLen)) {
  const [a, b] = lengths;
  const fa = (a - byLen[a]) / 2;
  const fb = (b - byLen[b]) / 2;
  const consistent = Math.abs(fa - fb) < 1e-6;
  const kind = byLen[b] > byLen[a] * 1.5 ? 'valid-conv' : 'downsampling?';
  console.log(`  ${name.padEnd(20)} flankBp≈${consistent ? fa : `${fa}/${fb} (inconsistent → not valid-conv)`}  [${kind}]`);
}

await session.release();

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "shell-files-consumer-"));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
function runNpm(args, cwd) {
  const npm = process.env.npm_execpath;
  return execFileSync(npm ? process.execPath : "npm", npm ? [npm, ...args] : args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
try {
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  for (const hook of ["install", "preinstall", "postinstall", "prepare"]) assert.equal(manifest.scripts[hook], undefined);
  const [packed] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root));
  for (const path of ["dist/index.js", "dist/index.d.ts", "dist/cjs/index.js", "dist/cjs/index.d.ts", "dist/cjs/package.json", "dist/browser/refstream.js", "dist/browser/refstream.global.js", "dist/browser/LICENSE", "LICENSE", "README.md"]) {
    assert(packed.files.some(file => file.path === path), `Missing distribution file: ${path}`);
  }
  assert(packed.files.every(file => !/^(?:node_modules|test|scripts)\//u.test(file.path)));
  await writeFile(join(temporary, "package.json"), JSON.stringify({ name: "isolated-files-consumer", private: true, type: "module" }));
  runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed.filename)], temporary);
  await rm(join(temporary, "node_modules/refstream.js/src"), { recursive: true, force: true });
  const check = `
assert.equal(typeof document, 'undefined');
assert.equal(typeof createFilePeer, 'function');
assert.equal(typeof FileChannel, 'function');
const files = new FileRegistry();
const registration = files.add('docs/readme.md', { body: '# Hello 世界' });
assert.equal(detectFiles('See docs/readme.md:4', files)[0].line, 4);
assert.equal(detectFiles('secret.txt', files).length, 0);
const links = fileLinks(files);
assert.equal(links.canResolve({ path: 'docs/readme.md' }), true);
const resource = await links.resolve({ path: 'docs/readme.md' }, { purpose: 'download', signal: new AbortController().signal });
assert.equal(await new Response(resource.body).text(), '# Hello 世界');
registration.dispose(); assert.equal(files.has('docs/readme.md'), false);
files.dispose(); files.dispose();
`;
  const names = "FileRegistry, fileLinks, detectFiles, createFilePeer, FileChannel";
  await writeFile(join(temporary, "consumer.mjs"), `import assert from 'node:assert/strict';\nimport { ${names} } from 'refstream.js';\n${check}`);
  await writeFile(join(temporary, "consumer.cjs"), `const assert = require('node:assert/strict');\nconst { ${names} } = require('refstream.js');\n(async () => {${check}})().catch(error => { console.error(error); process.exitCode = 1; });`);
  await writeFile(join(temporary, "browser.mjs"), `import assert from 'node:assert/strict';\nimport { ${names} } from 'refstream.js/browser/refstream.js';\n${check}`);
  for (const file of ["consumer.mjs", "consumer.cjs", "browser.mjs"]) execFileSync(process.execPath, [file], { cwd: temporary, stdio: "pipe" });
  const consumer = `import { FileRegistry, fileLinks, detectFiles, createFilePeer, type FilePeerDescription, type FileSource, type FileRequest } from 'refstream.js';
const files = new FileRegistry({ allowedOrigins: ['https://files.example'], maxConcurrentReads: 4 });
files.add('report.txt', { stream({ signal, purpose }: FileRequest) { return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }); }, authorize({ purpose }) { return purpose === 'preview'; } });
const source: FileSource = files;
const links = fileLinks(source);
const unsubscribe = links.onChange(() => {});
const peer = createFilePeer({ files, rtcConfiguration: { iceServers: [] } });
const description: Promise<FilePeerDescription> = peer.createOffer();
const results = detectFiles('report.txt:1', peer);
void description; void results; unsubscribe.dispose(); peer.dispose(); files.dispose();
`;
  const entries = ["types.mts", "types.cts"].map(name => join(temporary, name));
  for (const path of entries) await writeFile(path, consumer);
  const program = ts.createProgram(entries, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, types: [], skipLibCheck: false });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => temporary, getNewLine: () => "\n" }));
  console.log("Verified isolated file library: ESM, CommonJS, browser JS, streams, detection and TypeScript consumers.");
} finally { await rm(temporary, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "shell-terminal-package-"));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const npm = process.env.npm_execpath;
function runNpm(args, cwd) {
  return execFileSync(npm ? process.execPath : "npm", npm ? [npm, ...args] : args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
try {
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "Runtime dependencies must remain empty");
  assert.equal(manifest.name, "refstream.js");
  for (const name of ["install", "preinstall", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[name], undefined, "Installing the package must never require a compiler");
  }
  // Ignore prepack here so testing the pack hook does not recurse.
  const [packed] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root));
  for (const path of ["dist/index.js", "dist/index.d.ts", "dist/cjs/index.js", "dist/cjs/index.d.ts", "dist/search.js", "dist/search.d.ts", "dist/cjs/search.js", "dist/cjs/search.d.ts", "dist/style.css", "dist/ui.js", "dist/ui.d.ts", "dist/ui.css", "dist/relay.js", "dist/relay.d.ts", "dist/themes.js", "dist/cjs/ui.js", "dist/cjs/relay.js", "dist/refstream.global.js", "shell-integration/bash.sh", "shell-integration/zsh.sh", "LICENSE", "README.md"]) {
    assert(packed.files.some(file => file.path === path), `Missing package artifact: ${path}`);
  }
  assert(packed.files.every(file => !/^(?:node_modules|test|examples)\//u.test(file.path)));
  for (const path of ["dist/files/index.js", "dist/files/index.d.ts", "dist/cjs/files/index.js", "dist/cjs/files/index.d.ts", "dist/browser/files.js", "dist/browser/files.global.js"]) {
    assert(packed.files.some(file => file.path === path), `Missing optional file API: ${path}`);
  }
  for (const path of ["dist/browser/refstream.js", "dist/browser/ui.js", "dist/browser/refstream.css", "dist/browser/ui.css", "dist/browser/refstream.global.js", "dist/browser/LICENSE"]) {
    assert(packed.files.some(file => file.path === path), `Missing direct browser artifact: ${path}`);
  }
  await writeFile(join(temporary, "package.json"), JSON.stringify({ name: "isolated-terminal-consumer", private: true, type: "module" }));
  runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed.filename)], temporary);
  // Source maps retain sources for debugging, but consumers must only need dist.
  await rm(join(temporary, "node_modules/refstream.js/src"), { recursive: true, force: true });

  const assertion = `
assert.equal(typeof globalThis.window, 'undefined');
assert.equal(typeof globalThis.document, 'undefined');
assert.equal(Terminal, NativeTerminal);
assert.equal(TerminalCore, CoreEntry);
assert.equal(findInTerminal, SearchEntry);
assert.equal(terminalTranscript, TranscriptEntry);
assert.equal(typeof replayRecording, 'function');
assert.equal(typeof createTerminalAgentInvitation, 'function');
assert.equal(typeof attachTerminalTools, 'function');
assert.equal(typeof createFilePeer, 'function');
const files = new FileRegistry();
files.add('build.log', { body: 'Build passed' });
assert.equal(fileLinks(files).canResolve({ path: 'build.log' }), true);
assert.equal(detectFiles('build.log:1', files)[0].text, 'build.log:1');
files.dispose();
assert.equal(Object.keys(terminalThemes).length, 8);
assert.equal(normalizeTerminalRelay('https://relay.example/'), 'https://relay.example');
const core = new TerminalCore({ cols: 20, rows: 4 });
for (const byte of new TextEncoder().encode('hello 世界\\r\\n')) core.write(Uint8Array.of(byte));
assert.equal(core.getLine(0).translateToString(true), 'hello 世界');
const terminal = new Terminal({ theme: 'paper' });
const session = new TerminalSession(terminal);
terminal.write('headless');
assert.equal(terminal.buffer.active.getLine(0).translateToString(true), 'headless');
assert.equal(SearchEntry(terminal.buffer.active, terminal.cols, 'headless').length, 1);
const restored = new Terminal();
const restoredSession = new TerminalSession(restored);
restoredSession.restore(JSON.parse(JSON.stringify(session.snapshot())));
assert.equal(restoredSession.read().lines[0], 'headless');
assert.equal(restoredSession.read().executionPending, false);
assert.equal(TranscriptEntry(restored.buffer.active).trim(), 'headless');
session.dispose(); restoredSession.dispose(); restored.dispose();
terminal.reset(); terminal.dispose(); terminal.dispose();
`;
  await writeFile(join(temporary, "smoke.mjs"), `import assert from 'node:assert/strict';
import { Terminal, NativeTerminal, TerminalCore, TerminalSession, replayRecording, createTerminalAgentInvitation, findInTerminal, terminalTranscript } from 'refstream.js';
import { attachTerminalTools } from 'refstream.js/ui';
import { terminalThemes } from 'refstream.js/themes';
import { normalizeTerminalRelay } from 'refstream.js/relay';
import { TerminalCore as CoreEntry } from 'refstream.js/core';
import { FileRegistry, createFilePeer, detectFiles, fileLinks } from 'refstream.js/files';
import { findInTerminal as SearchEntry, terminalTranscript as TranscriptEntry } from 'refstream.js/search';
${assertion}`);
  await writeFile(join(temporary, "smoke.cjs"), `const assert = require('node:assert/strict');
const { Terminal, NativeTerminal, TerminalCore, TerminalSession, replayRecording, createTerminalAgentInvitation, findInTerminal, terminalTranscript } = require('refstream.js');
const { attachTerminalTools } = require('refstream.js/ui');
const { terminalThemes } = require('refstream.js/themes');
const { normalizeTerminalRelay } = require('refstream.js/relay');
assert(require.resolve('refstream.js/ui/style.css').endsWith('ui.css'));
const { TerminalCore: CoreEntry } = require('refstream.js/core');
const { FileRegistry, createFilePeer, detectFiles, fileLinks } = require('refstream.js/files');
const { findInTerminal: SearchEntry, terminalTranscript: TranscriptEntry } = require('refstream.js/search');
assert(require.resolve('refstream.js/style.css').endsWith('style.css'));
${assertion}`);
  for (const file of ["smoke.mjs", "smoke.cjs"]) execFileSync(process.execPath, [file], { cwd: temporary, stdio: "pipe" });
  await writeFile(join(temporary, "browser.mjs"), `import assert from 'node:assert/strict';
import { Terminal } from 'refstream.js/browser/refstream.js';
import { attachTerminalTools } from 'refstream.js/browser/ui.js';
import { FileRegistry } from 'refstream.js/browser/files.js';
assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof attachTerminalTools, 'function');
assert.equal(typeof FileRegistry, 'function');
const terminal = new Terminal(); terminal.write('Direct JavaScript');
assert.equal(terminal.buffer.active.getLine(0).translateToString(true), 'Direct JavaScript');
terminal.dispose();
`);
  execFileSync(process.execPath, ["browser.mjs"], { cwd: temporary, stdio: "pipe" });

  const consumer = `import { Terminal, TerminalSession, createTerminalAgentInvitation, type TerminalAgentInvitationOptions, type SessionSnapshot, type TerminalOptions, type TerminalSize } from 'refstream.js';
import { type TerminalUiOptions } from 'refstream.js/ui';
import { type TerminalFilePreviewUi } from 'refstream.js';
import { TerminalCore } from 'refstream.js/core';
import { findInTerminal, type TerminalMatch } from 'refstream.js/search';
import { FileRegistry, fileLinks } from 'refstream.js/files';
const ui: TerminalUiOptions = { toolbar: ['search', 'menu'], themes: ['paper', 'shell'], initialAgentPermission: 'read', initialRelay: 'mine', relays: [{ id: 'mine', label: 'My relay', url: 'https://relay.example.com' }], labels: { search: 'Find' } };
const previewUi: TerminalFilePreviewUi = { actions: ['download', 'close'], renderContent({ content, blob }) { content.textContent = String(blob.size); return { dispose() {} }; } };
const invitationOptions: TerminalAgentInvitationOptions = { relayUrl: 'https://relay.example.com', permission: 'read', client: { url: 'https://static.example.com/agent.mjs', sha256: 'a'.repeat(64) } };
ui.agentClient = invitationOptions.client;
void ui; void previewUi; void invitationOptions; void createTerminalAgentInvitation;
const options: TerminalOptions = { cols: 40, rows: 10, theme: 'midnight' };
const terminal = new Terminal(options);
const files = new FileRegistry();
terminal.options.fileLinks = fileLinks(files);
const subscription = terminal.onResize((size: TerminalSize) => terminal.resize(size.cols, size.rows));
terminal.options.fontSize = 16;
terminal.write(new Uint8Array([65]));
terminal.onData((data: string) => data.toUpperCase());
const size: TerminalSize | undefined = terminal.fit();
const core: TerminalCore = terminal.core;
const session = new TerminalSession(terminal);
const snapshot: SessionSnapshot = session.snapshot();
session.restore(snapshot);
const matches: TerminalMatch[] = findInTerminal(terminal.buffer.active, terminal.cols, 'text');
const pending: boolean = session.read().executionPending;
session.dispose(); subscription.dispose(); terminal.dispose();
void matches; void pending;
void size; void core;
`;
  const files = ["consumer.mts", "consumer.cts"].map(name => join(temporary, name));
  for (const file of files) await writeFile(file, consumer);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true,
    types: [], skipLibCheck: false,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => temporary, getNewLine: () => "\n",
  }));
  process.stdout.write(`Verified isolated tarball (${Math.round(packed.size / 1024)} KiB): ESM, CommonJS, SSR, CSS, and both TypeScript consumers.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

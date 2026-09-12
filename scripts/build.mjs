import { build } from "esbuild";
import ts from "typescript";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  process.exit(1);
}
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const entryPoints = (await readdir(join(root, "src"))).filter(name => name.endsWith(".ts")).map(name => join(root, "src", name));
const common = { entryPoints, target: "es2020", sourcemap: true, logLevel: "warning" };
await Promise.all([
  build({ ...common, format: "esm", outdir: dist }),
  build({ ...common, format: "cjs", outdir: join(dist, "cjs") }),
  build({ entryPoints: [join(root, "src/index.ts")], bundle: true, format: "esm", target: "es2020", minify: true, sourcemap: true, outfile: join(dist, "browser/refstream.js"), logLevel: "warning" }),
  build({ entryPoints: [join(root, "src/index.ts")], bundle: true, format: "iife", globalName: "Refstream", target: "es2020", minify: true, sourcemap: true, outfile: join(dist, "browser/refstream.global.js"), logLevel: "warning" }),
]);
for (const outDir of [dist, join(dist, "cjs")]) {
  if (ts.createProgram(parsed.fileNames, { ...parsed.options, outDir }).emit().emitSkipped) throw new Error("Type declaration generation failed");
}
await writeFile(join(dist, "cjs/package.json"), '{"type":"commonjs"}\n');
await copyFile(join(root, "LICENSE"), join(dist, "browser/LICENSE"));
process.stdout.write("Built refstream.js: browser JavaScript, ESM, CommonJS and types.\n");

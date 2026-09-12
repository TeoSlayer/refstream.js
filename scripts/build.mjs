import { build } from "esbuild";
import ts from "typescript";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const configPath = join(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name))
    : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []));
  return paths.flat();
}
const entryPoints = await sourceFiles(join(root, "src"));
const common = { entryPoints, outbase: join(root, "src"), target: "es2020", sourcemap: true, logLevel: "warning" };
await Promise.all([
  build({ ...common, format: "esm", outdir: dist }),
  build({ ...common, format: "cjs", outdir: join(dist, "cjs") }),
  build({ entryPoints: [join(root, "src/index.ts")], bundle: true, format: "iife", globalName: "Refstream", target: "es2020", minify: true, sourcemap: true, outfile: join(dist, "refstream.global.js"), logLevel: "warning" }),
  build({ entryPoints: { refstream: join(root, "src/index.ts"), ui: join(root, "src/ui.ts"), files: join(root, "src/files/index.ts") }, bundle: true, splitting: true, format: "esm", target: "es2020", minify: true, sourcemap: true, outdir: join(dist, "browser"), chunkNames: "chunks/[name]-[hash]", logLevel: "warning" }),
  build({ entryPoints: [join(root, "src/files/index.ts")], bundle: true, format: "iife", globalName: "RefstreamFiles", target: "es2020", minify: true, sourcemap: true, outfile: join(dist, "browser/files.global.js"), logLevel: "warning" }),
]);
for (const outDir of [dist, join(dist, "cjs")]) {
  const result = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir }).emit();
  if (result.emitSkipped) throw new Error("Type declaration generation failed");
}
await writeFile(join(dist, "cjs/package.json"), '{"type":"commonjs"}\n');
await copyFile(join(root, "src/native.css"), join(dist, "style.css"));
await copyFile(join(root, "src/ui.css"), join(dist, "ui.css"));
await copyFile(join(root, "src/native.css"), join(dist, "browser/refstream.css"));
await copyFile(join(root, "src/ui.css"), join(dist, "browser/ui.css"));
await copyFile(join(root, "LICENSE"), join(dist, "browser/LICENSE"));
await copyFile(join(dist, "refstream.global.js"), join(dist, "browser/refstream.global.js"));
await copyFile(join(dist, "refstream.global.js.map"), join(dist, "browser/refstream.global.js.map"));
process.stdout.write("Built refstream.js: ESM, CommonJS, browser global, CSS and types.\n");

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeMetafile, build as esbuildBuild, type Metafile as EsbuildMetafile } from "esbuild";
import { rolldown } from "rolldown";
import { build as tsdownBuild } from "tsdown";
import { build as viteBuild } from "vite";
import { afterAll, describe, expect, test } from "vitest";
import { metafile, type Metafile } from "../src/index.ts";

const scaffolds: string[] = [];
afterAll(() => {
  for (const dir of scaffolds) rmSync(dir, { recursive: true, force: true });
});

function scaffold(prefix: string) {
  const dir = mkdtempSync(join(import.meta.dirname, prefix));
  scaffolds.push(dir);
  return dir;
}

function appFixture() {
  const dir = scaffold(".tmp-");
  writeFileSync(
    join(dir, "entry.js"),
    `import { marked } from "marked";
import { helper } from "./util.js";
export const html = () => marked.parse(helper());
export const lazy = () => import("./lazy.js");
`,
  );
  writeFileSync(join(dir, "util.js"), `export const helper = () => "# hi";\n`);
  writeFileSync(join(dir, "lazy.js"), `export const answer = 42;\n`);
  return dir;
}

function readMetafile(outDir: string): Metafile {
  return JSON.parse(readFileSync(join(outDir, "metafile.json"), "utf8"));
}

describe("raw rolldown (no vite)", () => {
  test("emits a metafile esbuild itself can analyze", { timeout: 60_000 }, async () => {
    const dir = appFixture();
    const outDir = join(dir, "dist");
    const bundle = await rolldown({ input: join(dir, "entry.js"), plugins: [metafile()] });
    await bundle.write({ dir: outDir });
    await bundle.close();

    const meta = readMetafile(outDir);

    const compatible: EsbuildMetafile = meta;
    const analysis = await analyzeMetafile(compatible);
    expect(analysis).toContain("entry.js");
    expect(analysis).toContain("marked");

    const entryKey = Object.keys(meta.inputs).find((key) => key.endsWith("entry.js"));
    const entry = meta.inputs[entryKey!];
    expect(entry.format).toBe("esm");
    expect(
      entry.imports.some((imp) => imp.path.includes("marked") && imp.kind === "import-statement"),
    ).toBe(true);
    expect(entry.imports.some((imp) => imp.kind === "dynamic-import")).toBe(true);
    expect(entry.imports.every((imp) => !imp.external)).toBe(true);

    const outputKeys = Object.keys(meta.outputs);
    expect(outputKeys.every((key) => key.includes("dist/"))).toBe(true);
    const mainChunk = Object.values(meta.outputs).find((output) =>
      output.entryPoint?.endsWith("entry.js"),
    );
    expect(mainChunk).toBeTruthy();
    for (const imp of mainChunk!.imports) {
      if (!imp.external) expect(meta.outputs[imp.path]).toBeTruthy();
    }
  });

  test("bundle.generate() writes no file", { timeout: 60_000 }, async () => {
    const dir = appFixture();
    const bundle = await rolldown({ input: join(dir, "entry.js"), plugins: [metafile()] });
    await bundle.generate({});
    await bundle.close();
    expect(existsSync(join(dir, "metafile.json"))).toBe(false);
  });

  test("externalized packages are flagged, not dangling", { timeout: 60_000 }, async () => {
    const dir = appFixture();
    const outDir = join(dir, "dist-ext");
    const bundle = await rolldown({
      input: join(dir, "entry.js"),
      external: ["marked"],
      plugins: [metafile()],
    });
    await bundle.write({ dir: outDir });
    await bundle.close();

    const meta = readMetafile(outDir);
    const entryKey = Object.keys(meta.inputs).find((key) => key.endsWith("entry.js"));
    const markedImport = meta.inputs[entryKey!].imports.find((imp) => imp.path === "marked");
    expect(markedImport?.external).toBe(true);
    const mainChunk = Object.values(meta.outputs).find((output) => output.entryPoint);
    expect(mainChunk!.imports.find((imp) => imp.path === "marked")?.external).toBe(true);
  });

  test("bundled virtual modules are inputs, not externals", { timeout: 60_000 }, async () => {
    const dir = scaffold(".tmp-virtual-");
    writeFileSync(
      join(dir, "entry.js"),
      `import { flag } from "virtual:config";\nexport { flag };\n`,
    );
    const virtual: import("rolldown").Plugin = {
      name: "virtual",
      resolveId: (id) => (id === "virtual:config" ? id : null),
      load: (id) => (id === "virtual:config" ? `export const flag = true;` : null),
    };
    const bundle = await rolldown({
      input: join(dir, "entry.js"),
      plugins: [virtual, metafile()],
    });
    await bundle.write({ dir: join(dir, "dist") });
    await bundle.close();

    const meta = readMetafile(join(dir, "dist"));
    expect(meta.inputs["virtual:config"]).toBeTruthy();
    const entryKey = Object.keys(meta.inputs).find((key) => key.endsWith("entry.js"));
    const imp = meta.inputs[entryKey!].imports.find((entry) => entry.path === "virtual:config");
    expect(imp?.external).toBeUndefined();
  });

  test("sourcemaps give exact attribution, comments excluded", { timeout: 60_000 }, async () => {
    const dir = scaffold(".tmp-map-");
    const comment = `/* ${"x".repeat(400)} */`;
    writeFileSync(
      join(dir, "entry.js"),
      `import { tiny } from "./tiny.js";\nexport const n = tiny();\n`,
    );
    writeFileSync(join(dir, "tiny.js"), `${comment}\nexport const tiny = () => 1;\n`);
    const bundle = await rolldown({ input: join(dir, "entry.js"), plugins: [metafile()] });
    await bundle.write({ dir: join(dir, "dist"), sourcemap: true, minify: true });
    await bundle.close();

    const meta = readMetafile(join(dir, "dist"));
    const chunk = Object.values(meta.outputs).find((output) => output.entryPoint)!;
    const tinyKey = Object.keys(chunk.inputs).find((key) => key.endsWith("tiny.js"))!;
    expect(chunk.inputs[tinyKey].bytesInOutput).toBeLessThan(40);
    const attributed = Object.values(chunk.inputs).reduce(
      (sum, input) => sum + input.bytesInOutput,
      0,
    );
    expect(attributed).toBeGreaterThan(0);
    expect(attributed).toBeLessThanOrEqual(chunk.bytes);
  });
});

describe("parity with esbuild's own metafile", () => {
  test("same source produces structurally equivalent files", { timeout: 60_000 }, async () => {
    const dir = appFixture();

    const esbuildResult = await esbuildBuild({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      splitting: true,
      format: "esm",
      outdir: join(dir, "out-esbuild"),
      metafile: true,
      logLevel: "silent",
    });
    const theirs = esbuildResult.metafile;

    const bundle = await rolldown({ input: join(dir, "entry.js"), plugins: [metafile()] });
    await bundle.write({ dir: join(dir, "out-rolldown") });
    await bundle.close();
    const ours = readMetafile(join(dir, "out-rolldown"));

    const inputSet = (meta: EsbuildMetafile) => Object.keys(meta.inputs).sort();
    expect(inputSet(ours)).toEqual(inputSet(theirs));

    const entryImports = (meta: EsbuildMetafile) => {
      const key = Object.keys(meta.inputs).find((k) => k.endsWith("entry.js"))!;
      return meta.inputs[key].imports.map((imp) => `${imp.kind}:${imp.path}`).sort();
    };
    expect(entryImports(ours)).toEqual(entryImports(theirs));

    const normalize = (key: string) => key.replace(/out-(esbuild|rolldown)/, "out");
    const entryPoints = (meta: EsbuildMetafile) =>
      Object.values(meta.outputs)
        .map((output) => output.entryPoint)
        .filter(Boolean)
        .sort();
    expect(entryPoints(ours)).toEqual(entryPoints(theirs));
    const outputShape = (meta: EsbuildMetafile) =>
      Object.keys(meta.outputs)
        .filter((key) => key.endsWith(".js"))
        .map(normalize)
        .sort();
    expect(outputShape(ours).length).toBe(outputShape(theirs).length);
  });
});

describe("inside a tsdown build", () => {
  test("dual-format build keeps both formats in one metafile", { timeout: 60_000 }, async () => {
    const dir = appFixture();
    const outDir = join(dir, "dist");
    await tsdownBuild({
      entry: join(dir, "entry.js"),
      outDir,
      format: ["esm", "cjs"],
      plugins: [metafile()],
      dts: false,
      logLevel: "silent",
    });

    const meta = readMetafile(outDir);
    const keys = Object.keys(meta.outputs);
    expect(keys.some((key) => key.endsWith(".mjs"))).toBe(true);
    expect(keys.some((key) => key.endsWith(".cjs") || key.endsWith(".js"))).toBe(true);
    const compatible: EsbuildMetafile = meta;
    await analyzeMetafile(compatible);
  });
});

describe("inside a vite build", () => {
  test("captures the complete bundle including index.html", { timeout: 60_000 }, async () => {
    const dir = scaffold(".tmp-vite-");
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html>\n<script type="module" src="/main.js"></script>\n`,
    );
    writeFileSync(
      join(dir, "main.js"),
      `import { marked } from "marked";\ndocument.body.innerHTML = String(marked.parse("# hi"));\n`,
    );
    await viteBuild({ root: dir, logLevel: "silent", plugins: [metafile()] });

    const meta = readMetafile(join(dir, "dist"));
    const compatible: EsbuildMetafile = meta;
    const analysis = await analyzeMetafile(compatible);
    expect(analysis).toContain("marked");
    expect(Object.keys(meta.outputs).some((key) => key.endsWith("index.html"))).toBe(true);
    expect(Object.keys(meta.inputs).every((key) => !key.includes(" "))).toBe(true);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeMetafile, type Metafile as EsbuildMetafile } from "esbuild";
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
    expect(entryKey).toBeTruthy();
    const entry = meta.inputs[entryKey!];
    expect(entry.format).toBe("esm");
    expect(
      entry.imports.some((imp) => imp.path.includes("marked") && imp.kind === "import-statement"),
    ).toBe(true);
    expect(entry.imports.some((imp) => imp.kind === "dynamic-import")).toBe(true);

    const markedKey = Object.keys(meta.inputs).find((key) => key.includes("marked"));
    expect(meta.inputs[markedKey!].bytes).toBeGreaterThan(0);

    const mainChunk = Object.values(meta.outputs).find((output) =>
      output.entryPoint?.endsWith("entry.js"),
    );
    expect(mainChunk).toBeTruthy();
    expect(mainChunk!.bytes).toBeGreaterThan(0);
    const attributed = Object.values(mainChunk!.inputs).reduce(
      (sum, input) => sum + input.bytesInOutput,
      0,
    );
    expect(Math.abs(attributed - mainChunk!.bytes)).toBeLessThan(mainChunk!.bytes * 0.05);
    expect(mainChunk!.imports.some((imp) => imp.kind === "dynamic-import")).toBe(true);
    expect(Object.keys(meta.outputs).length).toBeGreaterThan(1);
  });
});

describe("inside a tsdown build", () => {
  test("writes the metafile into the out dir", { timeout: 60_000 }, async () => {
    const dir = appFixture();
    const outDir = join(dir, "dist");
    await tsdownBuild({
      entry: join(dir, "entry.js"),
      outDir,
      plugins: [metafile()],
      dts: false,
      logLevel: "silent",
    });

    const meta = readMetafile(outDir);
    const compatible: EsbuildMetafile = meta;
    const analysis = await analyzeMetafile(compatible);
    expect(analysis).toContain("marked");
    const entryKey = Object.keys(meta.inputs).find((key) => key.endsWith("entry.js"));
    expect(entryKey).toBeTruthy();
  });
});

describe("inside a vite build", () => {
  test("writes the metafile into dist", { timeout: 60_000 }, async () => {
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
    expect(Object.keys(meta.outputs).some((key) => key.endsWith(".js"))).toBe(true);
  });
});

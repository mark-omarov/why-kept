import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import type { OutputChunk, Plugin } from "rolldown";

export interface MetafileImport {
  path: string;
  kind: "import-statement" | "dynamic-import";
  external?: boolean;
}

export interface Metafile {
  inputs: Record<string, { bytes: number; imports: MetafileImport[]; format?: "esm" | "cjs" }>;
  outputs: Record<
    string,
    {
      bytes: number;
      inputs: Record<string, { bytesInOutput: number }>;
      imports: MetafileImport[];
      exports: string[];
      entryPoint?: string;
    }
  >;
}

const accumulated = new Map<string, Metafile>();

export function metafile(file = "metafile.json"): Plugin {
  let cwd = process.cwd();
  const rel = (id: string) => {
    const clean = id.startsWith("\0") ? id.slice(1) : id;
    const path = isAbsolute(clean) ? relative(cwd, clean) : clean;
    return path.split(sep).join("/");
  };

  return {
    name: "metafile",
    buildStart(options) {
      cwd = options.cwd ?? process.cwd();
    },
    writeBundle(options, bundle) {
      const outDir = options.dir
        ? resolve(cwd, options.dir)
        : options.file
          ? dirname(resolve(cwd, options.file))
          : cwd;

      const bundled = new Map<string, { code: string; format: string | undefined }>();
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (info?.code != null) bundled.set(id, { code: info.code, format: info.inputFormat });
      }
      const toImport = (id: string, kind: MetafileImport["kind"]): MetafileImport => ({
        path: rel(id),
        kind,
        ...(bundled.has(id) ? {} : { external: true }),
      });

      const inputs: Metafile["inputs"] = {};
      for (const id of bundled.keys()) {
        const info = this.getModuleInfo(id);
        if (!info) continue;
        inputs[rel(id)] = {
          bytes: sourceBytes(id, info.code),
          imports: [
            ...info.importedIds.map((imported) => toImport(imported, "import-statement")),
            ...info.dynamicallyImportedIds.map((imported) => toImport(imported, "dynamic-import")),
          ],
          ...(info.inputFormat === "cjs"
            ? { format: "cjs" as const }
            : info.inputFormat === "es"
              ? { format: "esm" as const }
              : {}),
        };
      }

      const chunkNames = new Set(Object.keys(bundle));
      const outKey = (name: string) => rel(join(outDir, name));
      const outputs: Metafile["outputs"] = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          outputs[outKey(output.fileName)] = {
            bytes: Buffer.byteLength(output.source),
            inputs: {},
            imports: [],
            exports: [],
          };
          continue;
        }
        outputs[outKey(output.fileName)] = {
          bytes: Buffer.byteLength(output.code),
          inputs: attributeBytes(output, outDir, rel),
          imports: [
            ...output.imports.map((name) =>
              chunkNames.has(name)
                ? { path: outKey(name), kind: "import-statement" as const }
                : { path: name, kind: "import-statement" as const, external: true },
            ),
            ...output.dynamicImports.map((name) =>
              chunkNames.has(name)
                ? { path: outKey(name), kind: "dynamic-import" as const }
                : { path: name, kind: "dynamic-import" as const, external: true },
            ),
          ],
          exports: [...output.exports],
          ...((output.isEntry || output.isDynamicEntry) && output.facadeModuleId
            ? { entryPoint: rel(output.facadeModuleId) }
            : {}),
        };
      }

      const merged = accumulated.get(outDir) ?? { inputs: {}, outputs: {} };
      Object.assign(merged.inputs, inputs);
      Object.assign(merged.outputs, outputs);
      accumulated.set(outDir, merged);

      const target = join(outDir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(merged));
    },
  };
}

function attributeBytes(
  chunk: OutputChunk,
  outDir: string,
  rel: (id: string) => string,
): Record<string, { bytesInOutput: number }> {
  const mapped = chunk.map ? attributeFromSourcemap(chunk, outDir, rel) : null;
  if (mapped) return mapped;

  const total = Object.values(chunk.modules).reduce((sum, mod) => sum + mod.renderedLength, 0);
  const scale = total > 0 ? Buffer.byteLength(chunk.code) / total : 0;
  const result: Record<string, { bytesInOutput: number }> = {};
  for (const [id, mod] of Object.entries(chunk.modules)) {
    result[rel(id)] = { bytesInOutput: Math.round(mod.renderedLength * scale) };
  }
  return result;
}

function attributeFromSourcemap(
  chunk: OutputChunk,
  outDir: string,
  rel: (id: string) => string,
): Record<string, { bytesInOutput: number }> | null {
  try {
    const tracer = new TraceMap(chunk.map as ConstructorParameters<typeof TraceMap>[0]);
    const mappings = decodedMappings(tracer);
    const lines = chunk.code.split("\n");
    const bySource = new Map<number, number>();
    for (const [lineIndex, segments] of mappings.entries()) {
      const lineLength = lines[lineIndex]?.length ?? 0;
      for (const [i, segment] of segments.entries()) {
        if (segment.length < 4) continue;
        const [column, sourceIndex] = segment;
        const end = segments[i + 1]?.[0] ?? lineLength;
        bySource.set(sourceIndex!, (bySource.get(sourceIndex!) ?? 0) + Math.max(0, end - column));
      }
    }
    const base = dirname(join(outDir, chunk.fileName));
    const result: Record<string, { bytesInOutput: number }> = {};
    for (const [sourceIndex, bytes] of bySource) {
      const source = tracer.sources[sourceIndex];
      if (!source) continue;
      result[rel(resolve(base, source))] = { bytesInOutput: bytes };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function sourceBytes(id: string, code: string | null): number {
  try {
    return statSync(id.split("?")[0]).size;
  } catch {
    return code ? Buffer.byteLength(code) : 0;
  }
}

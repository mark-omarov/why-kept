import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Plugin } from "rolldown";

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
      imports: { path: string; kind: "import-statement" | "dynamic-import" }[];
      exports: string[];
      entryPoint?: string;
    }
  >;
}

export function metafile(file = "metafile.json"): Plugin {
  const cwd = process.cwd();
  const rel = (id: string) => (isAbsolute(id) ? relative(cwd, id) : id);
  const inputs: Metafile["inputs"] = {};

  const toImport = (id: string, kind: MetafileImport["kind"]): MetafileImport => ({
    path: rel(id),
    kind,
    ...(isAbsolute(id) || id.startsWith("\0") ? {} : { external: true }),
  });

  return {
    name: "metafile",
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (!info || (!isAbsolute(id) && !id.startsWith("\0"))) continue;
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
    },
    generateBundle(options, bundle) {
      const outputs: Metafile["outputs"] = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          outputs[output.fileName] = {
            bytes: Buffer.byteLength(output.source),
            inputs: {},
            imports: [],
            exports: [],
          };
          continue;
        }
        const bytes = Buffer.byteLength(output.code);
        const renderedTotal = Object.values(output.modules).reduce(
          (sum, module) => sum + module.renderedLength,
          0,
        );
        const scale = renderedTotal > 0 ? bytes / renderedTotal : 0;
        const chunkInputs: Record<string, { bytesInOutput: number }> = {};
        for (const [id, module] of Object.entries(output.modules)) {
          chunkInputs[rel(id)] = { bytesInOutput: Math.round(module.renderedLength * scale) };
        }
        outputs[output.fileName] = {
          bytes,
          inputs: chunkInputs,
          imports: [
            ...output.imports.map((path) => ({ path, kind: "import-statement" as const })),
            ...output.dynamicImports.map((path) => ({ path, kind: "dynamic-import" as const })),
          ],
          exports: [...output.exports],
          ...(output.isEntry && output.facadeModuleId
            ? { entryPoint: rel(output.facadeModuleId) }
            : {}),
        };
      }
      const dir = options.dir ?? cwd;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify({ inputs, outputs }, null, 2));
    },
  };
}

function sourceBytes(id: string, code: string | null): number {
  try {
    return statSync(id.split("?")[0]).size;
  } catch {
    return code ? Buffer.byteLength(code) : 0;
  }
}

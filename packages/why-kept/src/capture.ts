import { gzipSync } from "node:zlib";
import {
  createBuilder,
  loadConfigFromFile,
  mergeConfig,
  type InlineConfig,
  type Plugin,
} from "vite";

export interface Mod {
  id: string;
  importers: string[];
  dynamicImporters: string[];
  importedIds: string[];
  exports: string[];
  isEntry: boolean;
  format: string;
  sideEffects: boolean | "no-treeshake" | null;
  code: string | null;
}

export interface Rendered {
  exports: string[];
  bytes: number;
}

export interface Snapshot {
  modules: Map<string, Mod>;
  rendered: Map<string, Rendered>;
  bytes: number;
  gzip: number;
}

export async function capture(
  root: string,
  keepCode: (id: string) => boolean,
  overrides: InlineConfig = {},
  env = "client",
): Promise<Snapshot> {
  const snap: Snapshot = { modules: new Map(), rendered: new Map(), bytes: 0, gzip: 0 };

  const plugin: Plugin = {
    name: "why-kept",
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const m = this.getModuleInfo(id);
        if (!m) continue;
        snap.modules.set(id, {
          id,
          importers: [...m.importers],
          dynamicImporters: [...m.dynamicImporters],
          importedIds: [...m.importedIds],
          exports: [...m.exports],
          isEntry: m.isEntry,
          format: m.inputFormat ?? "unknown",
          sideEffects: m.moduleSideEffects,
          code: [...m.importedIds, ...m.dynamicallyImportedIds].some(keepCode) ? m.code : null,
        });
      }
    },
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        const content = out.type === "chunk" ? out.code : out.source;
        snap.bytes += Buffer.byteLength(content);
        snap.gzip += gzipSync(content).length;
        if (out.type !== "chunk") continue;
        for (const [id, m] of Object.entries(out.modules)) {
          const prev = snap.rendered.get(id) ?? { exports: [], bytes: 0 };
          snap.rendered.set(id, {
            exports: [...new Set([...prev.exports, ...m.renderedExports])],
            bytes: prev.bytes + m.renderedLength,
          });
        }
      }
    },
  };

  const base: InlineConfig = {
    root,
    logLevel: "silent",
    build: { write: false },
    plugins: [plugin],
  };
  const builder = await createBuilder(mergeConfig(base, overrides));
  const environment = builder.environments[env];
  if (!environment) {
    throw new Error(
      `environment "${env}" not found; available: ${Object.keys(builder.environments).join(", ")}`,
    );
  }
  await builder.build(environment);
  return snap;
}

async function flatten(option: unknown): Promise<unknown[]> {
  const value = await option;
  if (Array.isArray(value)) return (await Promise.all(value.map(flatten))).flat();
  return [value];
}

function pluginName(p: unknown): string | undefined {
  return p && typeof p === "object" && "name" in p ? String(p.name) : undefined;
}

export async function loadConfigWithout(root: string, exclude: string[]): Promise<InlineConfig> {
  if (exclude.length === 0) return {};
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  if (!loaded) return {};
  const all = await flatten(loaded.config.plugins);
  const plugins = all.filter((p) => !exclude.includes(pluginName(p) ?? "")) as Plugin[];
  const { root: _ignored, ...config } = loaded.config;
  return { ...config, configFile: false, plugins };
}

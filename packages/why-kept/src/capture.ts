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
        const moduleInfo = this.getModuleInfo(id);
        if (!moduleInfo) continue;
        snap.modules.set(id, {
          id,
          importers: [...moduleInfo.importers],
          dynamicImporters: [...moduleInfo.dynamicImporters],
          importedIds: [...moduleInfo.importedIds],
          exports: [...moduleInfo.exports],
          isEntry: moduleInfo.isEntry,
          format: moduleInfo.inputFormat ?? "unknown",
          sideEffects: moduleInfo.moduleSideEffects,
          code: [...moduleInfo.importedIds, ...moduleInfo.dynamicallyImportedIds].some(keepCode)
            ? moduleInfo.code
            : null,
        });
      }
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        const content = output.type === "chunk" ? output.code : output.source;
        snap.bytes += Buffer.byteLength(content);
        snap.gzip += gzipSync(content).length;
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          const prev = snap.rendered.get(id) ?? { exports: [], bytes: 0 };
          snap.rendered.set(id, {
            exports: [...new Set([...prev.exports, ...module.renderedExports])],
            bytes: prev.bytes + module.renderedLength,
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

function pluginName(plugin: unknown): string | undefined {
  return plugin && typeof plugin === "object" && "name" in plugin ? String(plugin.name) : undefined;
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
  const plugins = all.filter((plugin) => !exclude.includes(pluginName(plugin) ?? "")) as Plugin[];
  const { root: _ignored, ...config } = loaded.config;
  return { ...config, configFile: false, plugins };
}

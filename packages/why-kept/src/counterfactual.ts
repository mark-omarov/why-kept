import { mergeConfig, type InlineConfig, type Plugin } from "vite";
import { capture, type Snapshot } from "./capture.ts";

export const SIDE_EFFECT_FREE_LABEL = "as side-effect free";

export interface Delta {
  label: string;
  bytes: number | null;
  gzip: number | null;
  note?: string;
}

const keepNothing = () => false;

export function sideEffectFreePlugin(query: string): Plugin {
  const marker = `/node_modules/${query}/`;
  return {
    name: "why-kept:side-effect-free",
    transform(code, id) {
      return id.includes(marker) ? { code, map: null, moduleSideEffects: false } : null;
    },
  };
}

export async function measure(
  root: string,
  query: string,
  base: Snapshot,
  target: { isPackage: boolean; hasEsm: boolean },
  baseOverrides: InlineConfig = {},
  env = "client",
): Promise<Delta[]> {
  if (!target.isPackage) {
    return [
      {
        label: "measurements skipped",
        bytes: null,
        gzip: null,
        note: "only package queries can be measured; a path query has nothing to externalize",
      },
    ];
  }

  const variants: Array<[string, string | undefined, InlineConfig]> = [
    [
      `without ${query}`,
      "upper bound: a replacement would add its own weight back",
      {
        build: {
          rolldownOptions: {
            external: (id: string) => id === query || id.startsWith(`${query}/`),
          },
        },
      },
    ],
  ];
  if (target.hasEsm) {
    variants.push([SIDE_EFFECT_FREE_LABEL, undefined, { plugins: [sideEffectFreePlugin(query)] }]);
  }

  const deltas: Delta[] = [];
  for (const [label, note, overrides] of variants) {
    try {
      const variant = await capture(root, keepNothing, mergeConfig(baseOverrides, overrides), env);
      deltas.push({
        label,
        note,
        bytes: base.bytes - variant.bytes,
        gzip: base.gzip - variant.gzip,
      });
    } catch (error) {
      deltas.push({
        label,
        bytes: null,
        gzip: null,
        note: `variant build failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
      });
    }
  }
  if (!target.hasEsm) {
    deltas.push({
      label: SIDE_EFFECT_FREE_LABEL,
      bytes: null,
      gzip: null,
      note: "n/a for CommonJS require chains",
    });
  }
  return deltas;
}

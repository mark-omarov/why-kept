import { mergeConfig, type InlineConfig } from "vite";
import { capture, type Snapshot } from "./capture.ts";

export interface Delta {
  label: string;
  bytes: number;
  gzip: number;
  note?: string;
}

const keepNothing = () => false;

export async function measure(
  root: string,
  query: string,
  base: Snapshot,
  hasEsmTargets: boolean,
  baseOverrides: InlineConfig = {},
  env = "client",
): Promise<Delta[]> {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variants: Array<[string, string | undefined, InlineConfig]> = [
    [
      "cost of presence",
      "upper bound of savings — a replacement would add its own weight",
      {
        build: {
          rolldownOptions: {
            external: (id: string) => id === query || id.startsWith(`${query}/`),
          },
        },
      },
    ],
  ];
  if (hasEsmTargets) {
    variants.push([
      "if marked side-effect free",
      undefined,
      {
        build: {
          rolldownOptions: {
            treeshake: {
              moduleSideEffects: [
                { test: new RegExp(`node_modules/${escaped}/`), sideEffects: false },
              ],
            },
          },
        },
      },
    ]);
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
    } catch {
      deltas.push({
        label: `${label} (variant build failed)`,
        bytes: Number.NaN,
        gzip: Number.NaN,
      });
    }
  }
  if (!hasEsmTargets) {
    deltas.push({
      label:
        "if marked side-effect free: n/a — side-effect flags cannot drop CommonJS require chains",
      bytes: Number.NaN,
      gzip: Number.NaN,
    });
  }
  return deltas;
}

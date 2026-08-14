import type { InlineConfig } from "vite";
import { capture, type Snapshot } from "./capture.ts";

export interface Delta {
  label: string;
  bytes: number;
  gzip: number;
}

const keepNothing = () => false;

export async function measure(
  root: string,
  query: string,
  base: Snapshot,
  hasEsmTargets: boolean,
): Promise<Delta[]> {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variants: Array<[string, InlineConfig]> = [
    [
      "if removed entirely",
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
  for (const [label, overrides] of variants) {
    try {
      const variant = await capture(root, keepNothing, overrides);
      deltas.push({ label, bytes: base.bytes - variant.bytes, gzip: base.gzip - variant.gzip });
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

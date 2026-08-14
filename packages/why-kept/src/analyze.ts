import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { init, parse } from "es-module-lexer";
import type { Mod, Snapshot } from "./capture.ts";

export interface Cause {
  kind: "cjs" | "side-effect-import" | "no-sideeffects-flag" | "export-star";
  confidence: "high" | "medium" | "low";
  detail: string;
  fix: string;
}

export interface ExportsDiff {
  id: string;
  format: string;
  kept: string[];
  removed: string[];
  bytes: number;
}

export function findTargets(snap: Snapshot, query: string): Mod[] {
  const asPackage = `/node_modules/${query}/`;
  const all = [...snap.modules.values()];
  const hits = all.filter((mod) => mod.id.includes(asPackage));
  return hits.length > 0 ? hits : all.filter((mod) => mod.id.includes(query));
}

export interface ChainLink {
  id: string;
  dynamic: boolean;
}

export function chainToEntry(snap: Snapshot, from: string): ChainLink[] {
  const prev = new Map<string, string>([[from, ""]]);
  const queue = [from];
  for (const id of queue) {
    const mod = snap.modules.get(id);
    if (!mod) continue;
    if (mod.isEntry) {
      const ids: string[] = [];
      for (let cur: string | undefined = id; cur; cur = prev.get(cur)) ids.push(cur);
      return ids.map((moduleId, index) => ({
        id: moduleId,
        dynamic:
          index > 0 &&
          (snap.modules.get(moduleId)?.dynamicImporters.includes(ids[index - 1]) ?? false),
      }));
    }
    for (const importer of [...mod.importers, ...mod.dynamicImporters]) {
      if (!prev.has(importer)) {
        prev.set(importer, id);
        queue.push(importer);
      }
    }
  }
  return [{ id: from, dynamic: false }];
}

export function exportsDiff(snap: Snapshot, targets: Mod[]): ExportsDiff[] {
  return targets
    .filter((target) => snap.rendered.has(target.id))
    .map((target) => {
      const rendered = snap.rendered.get(target.id)!;
      return {
        id: target.id,
        format: target.format,
        kept: rendered.exports,
        removed: target.exports.filter((name) => !rendered.exports.includes(name)),
        bytes: rendered.bytes,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

export async function classify(
  snap: Snapshot,
  targets: Mod[],
  query: string,
  root = process.cwd(),
): Promise<Cause[]> {
  await init;
  const causes: Cause[] = [];
  const kept = targets.filter((target) => snap.rendered.has(target.id));

  const cjs = kept.filter((target) => target.format === "cjs");
  if (cjs.length > 0) {
    causes.push({
      kind: "cjs",
      confidence: "high",
      detail: `${describeCjsShare(cjs.length, kept.length)}, which limits tree-shaking`,
      fix: "look for an ESM build or an ESM alternative",
    });
  }

  causes.push(...scanImportStatements(snap, query, root));

  const [firstKept] = kept;
  const pkg = firstKept ? nearestPackageJson(firstKept.id) : null;
  if (
    pkg &&
    pkg.json.sideEffects === undefined &&
    kept.some((target) => target.sideEffects !== false)
  ) {
    causes.push({
      kind: "no-sideeffects-flag",
      confidence: "medium",
      detail: `${pkg.json.name}/package.json has no "sideEffects" field, so bundlers keep every imported module whole`,
      fix: 'if the measured saving below is large, ask upstream to add "sideEffects": false',
    });
  }

  return dedupe(causes);
}

function scanImportStatements(snap: Snapshot, query: string, root: string): Cause[] {
  const causes: Cause[] = [];
  for (const mod of snap.modules.values()) {
    if (!mod.code) continue;
    let imports;
    try {
      [imports] = parse(mod.code);
    } catch {
      continue;
    }
    for (const spec of imports) {
      if (spec.d !== -1 || !spec.n || !matchesQuery(spec.n, query)) continue;
      const statement = mod.code.slice(spec.ss, spec.se);
      if (/^import\s*['"]/.test(statement)) {
        causes.push({
          kind: "side-effect-import",
          confidence: "high",
          detail: `${shortId(mod.id, root)}: \`${statement}\``,
          fix: "a bare import keeps the whole module for its side effects — drop it, or import something from it",
        });
      } else if (/^export\s*\*/.test(statement)) {
        causes.push({
          kind: "export-star",
          confidence: "low",
          detail: `${shortId(mod.id, root)}: \`${statement}\` re-exports everything, which can defeat export-level tree-shaking`,
          fix: "re-export named bindings instead of `export *`",
        });
      }
    }
  }
  return causes;
}

function describeCjsShare(cjs: number, kept: number): string {
  if (kept === 1) return "the kept module is CommonJS";
  if (cjs === kept) return `all ${kept} kept modules are CommonJS`;
  return `${cjs} of ${kept} kept modules are CommonJS`;
}

function matchesQuery(specifier: string, query: string): boolean {
  return (
    specifier === query || specifier.startsWith(`${query}/`) || specifier.includes(`/${query}/`)
  );
}

interface PkgJson {
  name?: string;
  version?: string;
  sideEffects?: unknown;
}

const pkgCache = new Map<string, { path: string; json: PkgJson } | null>();

function nearestPackageJson(id: string): { path: string; json: PkgJson } | null {
  const start = dirname(id.split("?")[0]);
  if (pkgCache.has(start)) return pkgCache.get(start)!;
  let dir = start;
  let found: { path: string; json: PkgJson } | null = null;
  while (dir.includes("node_modules") && dir !== dirname(dir)) {
    const path = join(dir, "package.json");
    try {
      const json = JSON.parse(readFileSync(path, "utf8"));
      if (json.name) {
        found = { path, json };
        break;
      }
    } catch {}
    dir = dirname(dir);
  }
  pkgCache.set(start, found);
  return found;
}

export function versionSummary(targets: Mod[]): string | null {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const version = nearestPackageJson(target.id)?.json.version ?? "?";
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  if (counts.size < 2) return null;
  const list = [...counts].map(([version, count]) => `${version} (${count} modules)`).join(", ");
  return `${list} — multiple copies bundled, dedupe opportunity`;
}

function dedupe(causes: Cause[]): Cause[] {
  const seen = new Set<string>();
  return causes.filter((cause) => {
    const key = cause.kind + cause.detail;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

export function shortId(id: string, root = process.cwd()): string {
  const index = id.lastIndexOf("node_modules/");
  return index === -1 ? id.replace(`${root}/`, "") : id.slice(index + "node_modules/".length);
}

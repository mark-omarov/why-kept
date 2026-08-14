import { describe, expect, test } from "vitest";
import type { Mod, Snapshot } from "../src/capture.ts";
import { chainToEntry, classify, exportsDiff, findTargets, shortId } from "../src/analyze.ts";

function mod(id: string, over: Partial<Mod> = {}): Mod {
  return {
    id,
    importers: [],
    dynamicImporters: [],
    importedIds: [],
    exports: [],
    isEntry: false,
    format: "es",
    sideEffects: null,
    code: null,
    ...over,
  };
}

function snapshot(mods: Mod[], rendered: Array<[string, string[], number]> = []): Snapshot {
  return {
    modules: new Map(mods.map((m) => [m.id, m])),
    rendered: new Map(rendered.map(([id, exports, bytes]) => [id, { exports, bytes }])),
    bytes: 0,
    gzip: 0,
  };
}

describe("findTargets", () => {
  test("matches pnpm-style node_modules paths by package name", () => {
    const snap = snapshot([
      mod("/p/node_modules/.pnpm/lodash@4.18.1/node_modules/lodash/debounce.js"),
      mod("/p/src/lodash-helpers.js"),
    ]);
    const hits = findTargets(snap, "lodash");
    expect(hits.map((m) => m.id)).toEqual([
      "/p/node_modules/.pnpm/lodash@4.18.1/node_modules/lodash/debounce.js",
    ]);
  });

  test("falls back to substring match for local paths", () => {
    const snap = snapshot([mod("/p/src/utils/heavy.js")]);
    expect(findTargets(snap, "heavy")).toHaveLength(1);
  });
});

describe("chainToEntry", () => {
  test("returns entry-to-target chain and marks dynamic edges", () => {
    const snap = snapshot([
      mod("/p/main.js", { isEntry: true }),
      mod("/p/mid.js", { importers: ["/p/main.js"] }),
      mod("/p/leaf.js", { dynamicImporters: ["/p/mid.js"] }),
    ]);
    expect(chainToEntry(snap, "/p/leaf.js")).toEqual([
      { id: "/p/main.js", dynamic: false },
      { id: "/p/mid.js", dynamic: false },
      { id: "/p/leaf.js", dynamic: true },
    ]);
  });
});

describe("classify", () => {
  test("flags CommonJS modules", async () => {
    const target = mod("/p/node_modules/x/index.js", { format: "cjs" });
    const snap = snapshot([target], [[target.id, [], 100]]);
    const causes = await classify(snap, [target], "x");
    expect(causes.some((c) => c.kind === "cjs")).toBe(true);
  });

  test("detects bare side-effect imports and export-star in importer code", async () => {
    const target = mod("/p/node_modules/x/index.js");
    const importer = mod("/p/main.js", {
      importedIds: [target.id],
      code: `import 'x/polyfill'\nexport * from 'x/barrel'\nimport { a } from 'x'\n`,
    });
    const snap = snapshot([target, importer], [[target.id, [], 100]]);
    const causes = await classify(snap, [target], "x");
    expect(causes.some((c) => c.kind === "side-effect-import")).toBe(true);
    expect(causes.some((c) => c.kind === "export-star")).toBe(true);
  });

  test("does not misfire bare-import on named imports", async () => {
    const target = mod("/p/node_modules/x/index.js");
    const importer = mod("/p/main.js", {
      importedIds: [target.id],
      code: `import { a } from 'x'\n`,
    });
    const snap = snapshot([target, importer], [[target.id, [], 100]]);
    const causes = await classify(snap, [target], "x");
    expect(causes.some((c) => c.kind === "side-effect-import")).toBe(false);
  });
});

describe("exportsDiff", () => {
  test("splits kept and removed exports, sorted by bytes", () => {
    const a = mod("/p/a.js", { exports: ["x", "y", "z"] });
    const b = mod("/p/b.js", { exports: ["q"] });
    const snap = snapshot(
      [a, b],
      [
        [a.id, ["x"], 10],
        [b.id, ["q"], 20],
      ],
    );
    const diff = exportsDiff(snap, [a, b]);
    expect(diff[0]).toMatchObject({ id: "/p/b.js", kept: ["q"], removed: [] });
    expect(diff[1]).toMatchObject({ id: "/p/a.js", kept: ["x"], removed: ["y", "z"] });
  });
});

test("shortId trims node_modules prefix", () => {
  expect(shortId("/p/node_modules/.pnpm/x@1/node_modules/x/i.js")).toBe("x/i.js");
});

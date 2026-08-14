# rolldown-plugin-metafile

Emits an esbuild-compatible metafile from Rolldown, tsdown, and Vite builds. The existing ecosystem of metafile tools keeps working: esbuild's own [Bundle Size Analyzer](https://esbuild.github.io/analyze/), bundle-buddy, CI size-diff bots, and anything else that reads the format.

Rolldown does not emit metafiles yet ([rolldown#6425](https://github.com/rolldown/rolldown/issues/6425)). This plugin fills the gap from the public plugin API for now.

## Usage

Rolldown:

```js
import { rolldown } from "rolldown";
import { metafile } from "rolldown-plugin-metafile";

const bundle = await rolldown({ input: "src/index.js", plugins: [metafile()] });
await bundle.write({ dir: "dist" });
```

tsdown (`tsdown.config.ts`):

```js
import { defineConfig } from "tsdown";
import { metafile } from "rolldown-plugin-metafile";

export default defineConfig({ entry: "src/index.ts", plugins: [metafile()] });
```

Vite (`vite.config.js`):

```js
import { metafile } from "rolldown-plugin-metafile";

export default { plugins: [metafile()] };
```

Each build writes `metafile.json` next to the output. Pass a name to change it: `metafile("meta.json")`. Drop the file into [esbuild.github.io/analyze](https://esbuild.github.io/analyze/), or diff two of them in CI.

## Fidelity

Exact, read from the build: output sizes, chunk imports, exports, entry points, the input import graph (static and dynamic edges, externals flagged), and module format (`esm`/`cjs`).

Approximate: `bytesInOutput` per input. Rolldown reports pre-minification rendered sizes, so this plugin scales them to the real chunk size proportionally. Exact post-minification attribution needs data the bundler does not expose yet.

Not emitted: import kinds beyond `import-statement`/`dynamic-import` (no `require-call`, `import-rule`, `url-token`), and `cssBundle`.

Compatibility is tested against esbuild itself: the suite type-checks the output against esbuild's `Metafile` type and feeds it to `esbuild.analyzeMetafile()`.

## Requirements

Rolldown ≥ 1.0, or any tool built on it (tsdown, Vite 8+). Node 20.19+.

MIT

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

Each write puts `metafile.json` next to the output. Pass a name to change it: `metafile("meta.json")`. Drop the file into [esbuild.github.io/analyze](https://esbuild.github.io/analyze/), or diff two of them in CI. Multi-format builds into one directory (tsdown `format: ["esm", "cjs"]`) merge into a single metafile. In-memory `bundle.generate()` writes nothing.

The metafile lands inside your output directory, so exclude it from publishing (`files`, `.npmignore`) if your `dist` ships to npm.

## Fidelity

Exact, read from the build: output sizes, chunk imports, exports, entry points, the input import graph (static and dynamic edges), and module format (`esm`/`cjs`). A module is external when the bundler kept no code for it, not guessed from its path, so bundled virtual modules stay inputs. Paths follow esbuild's convention: everything relative to the build's cwd, output keys including the out dir.

`bytesInOutput`: exact when sourcemaps are enabled — attribution is computed from the chunk's own sourcemap, so minification and comment stripping are accounted for. Without sourcemaps it falls back to scaling Rolldown's pre-minification rendered sizes proportionally, which overweights comment-heavy modules. Enable `sourcemap` for numbers you want to trust.

Not emitted: import kinds beyond `import-statement`/`dynamic-import` (no `require-call`, `import-rule`, `url-token`), `cssBundle`, and CSS outputs carry no input attribution (Vite emits CSS as assets).

Compatibility is tested against esbuild itself: the suite builds identical source with esbuild and with this plugin and compares the files structurally, type-checks the output against esbuild's `Metafile` type, and feeds it to `esbuild.analyzeMetafile()`.

## Requirements

Rolldown ≥ 1.0, or any tool built on it (tsdown, Vite 8+). Node 20.19+.

MIT

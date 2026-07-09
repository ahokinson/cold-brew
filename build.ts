import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import pkg from "./package.json" with { type: "json" }

// The release workflow exports COLD_BREW_VERSION from the git tag; local builds
// fall back to package.json. Baked in via `define` so the compiled binary can
// report its version without reading package.json at runtime.
const version = process.env.COLD_BREW_VERSION ?? pkg.version

await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  plugins: [createSolidTransformPlugin()],
  define: {
    "process.env.COLD_BREW_VERSION": JSON.stringify(version),
  },
})

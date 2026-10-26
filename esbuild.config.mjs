import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const production = process.argv[2] === "production";
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const releaseDir = join("release", manifest.id);

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: production ? join(releaseDir, "main.js") : "main.js"
});

if (production) {
  await Promise.all(
    ["manifest.json", "styles.css"].map((file) => copyFile(file, join(releaseDir, file)))
  );
}

import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const production = process.argv[2] === "production";
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const releaseDir = join("release", manifest.id);
const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
if (manifest.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Версии manifest.json и package.json должны совпадать и иметь формат x.y.z.");
}

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, "node:*"],
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
  const destination = process.env.CLOOM_PLUGIN_DIR;
  if (destination && resolve(destination) !== resolve(releaseDir)) {
    await mkdir(destination, { recursive: true });
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(join(releaseDir, file), join(destination, file));
    }
    console.log(`Плагин скопирован: ${destination}`);
  }
}

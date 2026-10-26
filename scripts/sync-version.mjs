// Runs from `npm version` (cwd = package root): copies package.json's version into src/version.ts.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const path = "src/version.ts";
const source = readFileSync(path, "utf8");
if (!/APP_VERSION = "[^"]*"/.test(source)) throw new Error(`APP_VERSION not found in ${path}`);
writeFileSync(path, source.replace(/APP_VERSION = "[^"]*"/, `APP_VERSION = "${version}"`));

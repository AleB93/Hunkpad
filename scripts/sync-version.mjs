// Copies package.json's version into src-tauri/Cargo.toml. package.json is the
// one place the version is set (tauri.conf.json reads it from there); npm runs
// this from the "version" script, so `npm version 0.2.0` updates both files.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cargo = new URL("../src-tauri/Cargo.toml", import.meta.url);
const text = readFileSync(cargo, "utf8");
const updated = text.replace(/^version = ".*"$/m, `version = "${version}"`);
if (updated !== text) writeFileSync(cargo, updated);
console.log(`Version ${version}`);

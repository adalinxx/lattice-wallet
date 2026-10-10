import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, cpSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, utimesSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { writeBundleNotices } from "./bundle-notices.mjs";

execFileSync(process.execPath, ["build.mjs", "--metafile"], { stdio: "inherit" });
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== pkg.version || manifest.name !== "Lattice Wallet" || manifest.manifest_version !== 3) throw new Error("Release metadata mismatch");
const references = [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
for (const file of references) if (!existsSync(`dist/${file}`)) throw new Error(`Missing manifest asset: ${file}`);
cpSync("LICENSE", "dist/LICENSE");
const bundled = writeBundleNotices(JSON.parse(readFileSync("release/bundle-metafile.json", "utf8")));
console.log(`Included licenses for ${bundled.length} bundled package versions`);
mkdirSync("release", { recursive: true });
const zip = resolve(`release/lattice-wallet-${manifest.version}.zip`);
if (existsSync(zip)) unlinkSync(zip);
// Normalize timestamps, permissions and entry ordering. Reproducibility is
// scoped to the same Node/dependency/zip toolchain, not a hermetic build.
const files = readdirSync("dist", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name).slice(resolve("dist").length + 1))
  .sort();
const epoch = new Date("2000-01-01T00:00:00Z");
for (const file of files) { utimesSync(`dist/${file}`, epoch, epoch); chmodSync(`dist/${file}`, 0o644); }
execFileSync("zip", ["-X", "-q", zip, ...files], { cwd: "dist", env: { ...process.env, TZ: "UTC" } });
const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n");
if (!entries.includes("manifest.json") || entries.some((p) => p.endsWith(".map") || p.includes("node_modules/"))) throw new Error("Invalid release contents");
const digest = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${digest}  lattice-wallet-${manifest.version}.zip\n`);
console.log(`${zip}\nSHA-256 ${digest}`);

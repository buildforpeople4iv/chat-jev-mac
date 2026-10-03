import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const src = resolve("../shared/definitions.json");
const dst = resolve("src/generated/definitions.json");
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log("synced shared/definitions.json -> src/generated/");

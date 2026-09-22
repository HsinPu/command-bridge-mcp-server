// The build replaces dist/version.js using package.json as the source of truth.
import { readFileSync } from "node:fs";
export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

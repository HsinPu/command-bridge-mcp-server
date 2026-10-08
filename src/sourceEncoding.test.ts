import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("source text is valid UTF-8 and non-ASCII PowerShell 5.1 scripts must carry a UTF-8 BOM", () => {
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.(?:ts|mjs|ps1|sh|cmd|md|json|yml|xml)$/.test(file) || file.includes(".tmp.")) continue;
      const bytes = readFileSync(file);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { assert.fail(`Invalid UTF-8 source: ${file}`); }
      if (file.endsWith(".ps1") && /[^\x00-\x7f]/.test(text)) {
        assert.equal(bytes.subarray(0,3).toString("hex"), "efbbbf", `Windows PowerShell 5.1 requires BOM for non-ASCII script source: ${file}`);
      }
    }
  };
  for (const directory of ["src", "scripts", "docs", "packaging", ".github"]) visit(directory);
  for (const file of ["README.md", "README.zh-TW.md", "AGENTS.md", "CHANGELOG.md", "package.json", "package-lock.json"]) {
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)), `Invalid UTF-8: ${file}`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createOutputDecoder, decodeUtf8File, assertOutputEncoding, type OutputEncoding } from "./textEncoding.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

test("UTF-8, UTF-16LE, Big5, GBK and GB18030 decode every byte boundary without substitution", () => {
  const cases: [OutputEncoding, Buffer, string][] = [
    ["utf8", Buffer.from("中文🙂"), "中文🙂"],
    ["utf16le", Buffer.from("中文🙂", "utf16le"), "中文🙂"],
    ["big5", Buffer.from("a4a4a4e5", "hex"), "中文"],
    ["gbk", Buffer.from("d6d0cec4", "hex"), "中文"],
    ["gb18030", Buffer.from("d6d0cec481308130", "hex"), "中文\u0080"]
  ];
  for (const [encoding, bytes, expected] of cases) {
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoder = createOutputDecoder(encoding);
      assert.equal(decoder.decode(bytes.subarray(0, cut), { stream: true }) + decoder.decode(bytes.subarray(cut)), expected, `${encoding}:${cut}`);
    }
  }
});

test("invalid or incomplete output bytes fail explicitly; managed UTF-8 files accept BOM without conversion", () => {
  const decoder = createOutputDecoder("utf8");
  decoder.decode(Buffer.from([0xe4]), { stream: true });
  assert.throws(() => decoder.decode());
  assert.throws(() => createOutputDecoder("utf8").decode(Buffer.from([0xff])));
  assert.throws(() => assertOutputEncoding("auto"), (error: any) => error.code === "OUTPUT_ENCODING_INVALID");
  const content = "# 中文🙂\r\n";
  assert.equal(decodeUtf8File(Buffer.from(content)), content);
  assert.equal(decodeUtf8File(Buffer.concat([Buffer.from([239,187,191]), Buffer.from(content)])), content);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4]), Buffer.from(content, "utf16le")]) assert.throws(() => decodeUtf8File(bytes), /valid UTF-8/);
});

test("Linux managed-update log tails keep whole UTF-8 characters within the byte limit", async () => {
  const { utf8LogTail } = await import(pathToFileURL(resolve("scripts/managed-update/state.mjs")).href);
  const content = "中文🙂".repeat(10), bytes = Buffer.from(content);
  for (let limit = 4; limit <= bytes.length + 1; limit++) {
    const tail = utf8LogTail(bytes, limit), text = new TextDecoder("utf-8", { fatal: true }).decode(tail);
    assert.ok(content.endsWith(text)); assert.ok(tail.length <= limit);
  }
});

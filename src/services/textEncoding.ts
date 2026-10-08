import { AppError } from "../errors/AppError.js";

export const outputEncodings = ["utf8", "utf16le", "big5", "gbk", "gb18030"] as const;
export type OutputEncoding = typeof outputEncodings[number];

export function assertOutputEncoding(value: unknown): asserts value is OutputEncoding {
  if (!outputEncodings.includes(value as OutputEncoding)) {
    throw new AppError("OUTPUT_ENCODING_INVALID", "Unsupported command output encoding.",
      "Use utf8, utf16le, big5, gbk or gb18030; select the encoding the program actually emits.");
  }
}

export function createOutputDecoder(encoding: OutputEncoding): TextDecoder {
  // Preserve a literal BOM in command output. Never replace undecodable bytes:
  // callers could otherwise use corrupted text to rewrite a whole document.
  return new TextDecoder(encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : encoding,
    { fatal: true, ignoreBOM: true });
}

export function outputDecodingError(): AppError {
  return new AppError("COMMAND_OUTPUT_ENCODING_INVALID", "Command output does not match the selected encoding; output was withheld.",
    "Select outputEncoding for the actual program output or configure the program to emit UTF-8. Do not rewrite a file from garbled or truncated command output. File transfer preserves bytes without transcoding.");
}

export function decodeUtf8File(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("NUL is forbidden in managed text files.");
    return text;
  }
  catch { throw new Error("Managed text file must be valid UTF-8 (optional UTF-8 BOM). Restore or explicitly convert a backup; no encoding conversion was performed."); }
}

import test from "node:test";
import assert from "node:assert/strict";
import { commandVerificationSummary } from "./verificationSummary.js";
test("verification failures report fixed codes and flags without private output", () => {
  const secret = "private_secret_credential";
  const text = commandVerificationSummary({ isError: true, command: secret, structuredContent: { ok: false, exitCode: 1, stdout: secret, stderr: secret, error: { code: "COMMAND_NOT_ALLOWED", message: secret } } });
  assert.match(text, /code=COMMAND_NOT_ALLOWED error=1 ok=0 exit=1/); assert.ok(!text.includes(secret));
  assert.equal(commandVerificationSummary({ structuredContent: { exitCode: secret, error: { code: secret } } }), "VERIFIER_COMMAND_FAILURE code=UNKNOWN error=0 ok=0 exit=unknown timeout=0 truncated=0");
  assert.match(commandVerificationSummary(null), /code=UNKNOWN/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAllowedHosts } from "./allowedHosts.js";

test("allowed Host entries normalize ports, case and IPv6 without wildcard matches", () => {
  assert.deepEqual(normalizeAllowedHosts("Bridge.INTERNAL:8800,127.0.0.1:8800,[0:0:0:0:0:0:0:1]:8800,::1, bridge.internal"), ["bridge.internal", "127.0.0.1", "[::1]"]);
  assert.deepEqual(normalizeAllowedHosts(undefined), []);
  for (const value of ["http://bridge.internal", "*.internal", "bridge/path", "user@bridge", "bridge?x", "bridge#x", "bridge:0", "bridge:65536", "bridge:abc", "[::1", "[gg::1]", "bridge\\other", "bridge\nother", "bridge:"]) {
    assert.throws(() => normalizeAllowedHosts(value), /COMMAND_BRIDGE_ALLOWED_HOSTS/, value);
  }
});

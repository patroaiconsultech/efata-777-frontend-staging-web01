import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/routes/AppConsole.tsx", "utf8");
const match = source.match(
  /const realtimeReason =([\s\S]*?);\s*const realtimeReady =/
);
assert.ok(match, "the canonical realtime reason expression must exist");

// Execute the exact pure expression from the component against fixture data.
// This avoids a mock implementation diverging from the production source.
const reason = new Function(
  "realtimeCapabilities",
  `"use strict"; return (${match[1].trim()});`
);

const eligible = (reason_code = "INFORMATIONAL") => ({eligible: true, reason_code});
const blocked = (reason_code) => ({eligible: false, reason_code});

test("voice output blocker is not masked by eligible bridge reason", () => {
  assert.equal(reason({
    realtime_session: eligible("SESSION_INFO"),
    orchestration_bridge: eligible("REALTIME_CANONICAL_BRIDGE_CONFIGURED_NOT_RUNTIME_PROVEN"),
    voice_input: eligible("INPUT_INFO"),
    voice_output: blocked("AGENT_VOICE_BINDING_NOT_VALIDATED"),
    streaming: blocked("NON_BLOCKING_STREAMING"),
  }), "AGENT_VOICE_BINDING_NOT_VALIDATED");
});

test("priority follows the actual readiness gates", () => {
  const all = {
    realtime_session: eligible(),
    orchestration_bridge: eligible(),
    voice_input: eligible(),
    voice_output: eligible(),
  };
  assert.equal(reason({...all, realtime_session: blocked("SESSION_BLOCKED")}), "SESSION_BLOCKED");
  assert.equal(reason({...all, orchestration_bridge: blocked("BRIDGE_BLOCKED")}), "BRIDGE_BLOCKED");
  assert.equal(reason({...all, voice_input: blocked("INPUT_BLOCKED")}), "INPUT_BLOCKED");
  assert.equal(reason({...all, voice_output: blocked("OUTPUT_BLOCKED")}), "OUTPUT_BLOCKED");
});

test("streaming fallback alone never blocks canonical realtime", () => {
  const all = {
    realtime_session: eligible(),
    orchestration_bridge: eligible(),
    voice_input: eligible(),
    voice_output: eligible(),
    streaming: blocked("OPTIONAL_FALLBACK"),
  };
  assert.equal(reason(all), "REALTIME_CAPABILITY_NOT_PROVEN");
});

test("missing capabilities fail visibly without granting microphone access", () => {
  assert.equal(reason(null), "REALTIME_CAPABILITY_NOT_PROVEN");
  assert.match(source, /if \(!realtimeReady\) \{\s*setShowRealtimeInfo\(true\);/);
  assert.match(source, /const realtimeReady = Boolean\([\s\S]*?voice_output\?\.eligible/);
  assert.match(source, /onClick=\{handleRealtimeButton\}/);
});

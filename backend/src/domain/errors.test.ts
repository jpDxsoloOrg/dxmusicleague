// ApiError body tests — what both HTTP adapters serialize (errorBody), and
// the client-side reader for the invite path's already-member 409 (IMP-03).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALREADY_MEMBER_CODE, ApiError, alreadyMember, alreadyMemberLeagueId, badRequest, conflict, errorBody, notFound } from "./errors.ts";

test("errorBody: a plain error stays exactly { error } (no code, no undefined keys)", () => {
  for (const err of [badRequest("Nope."), notFound(), conflict("This league is full."), new ApiError(401, "Not signed in.")]) {
    const body = errorBody(err);
    assert.deepEqual(body, { error: err.message });
    assert.equal(JSON.stringify(body), JSON.stringify({ error: err.message }));
  }
});

test("errorBody: details ride beside `error`, which a detail can't overwrite", () => {
  assert.deepEqual(errorBody(conflict("Taken.", { code: "taken", slot: 3 })), { error: "Taken.", code: "taken", slot: 3 });
  assert.deepEqual(errorBody(conflict("Real message.", { code: "x", error: "spoofed" })), { error: "Real message.", code: "x" });
});

test("alreadyMember: 409, the pre-existing message, the marker and the league id", () => {
  const err = alreadyMember({ id: "lg-synthwave", name: "Synthwave Souls" });
  assert.equal(err.statusCode, 409);
  assert.equal(err.message, "You're already a member of Synthwave Souls.");
  assert.equal(ALREADY_MEMBER_CODE, "already-member");
  assert.deepEqual(errorBody(err), {
    error: "You're already a member of Synthwave Souls.",
    code: "already-member",
    leagueId: "lg-synthwave",
  });
});

test("alreadyMemberLeagueId: reads the marker round-tripped through JSON; anything else is undefined", () => {
  const wire = JSON.parse(JSON.stringify(errorBody(alreadyMember({ id: "lg-1", name: "L" }))));
  assert.equal(alreadyMemberLeagueId(wire), "lg-1");
  // Older servers (plain `{ error }`), other codes, malformed or missing bodies.
  for (const body of [
    { error: "You're already a member of L." },
    { error: "x", code: "other", leagueId: "lg-1" },
    { error: "x", code: ALREADY_MEMBER_CODE },
    { error: "x", code: ALREADY_MEMBER_CODE, leagueId: "" },
    { error: "x", code: ALREADY_MEMBER_CODE, leagueId: 42 },
    null,
    undefined,
    "already-member",
    [],
  ]) {
    assert.equal(alreadyMemberLeagueId(body), undefined, JSON.stringify(body));
  }
});

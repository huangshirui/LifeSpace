import assert from "node:assert/strict";
import test from "node:test";
import { planApacConfirmation, evaluateApacConfirmation } from "../../../infra/scripts/apac-release-acceptance.mjs";

const target = { p50Ms: 150, p90Ms: 250 };
function metric(slowCount = 0, slowMs = 263) {
  const sampleMs = [
    ...Array.from({ length: 45 - slowCount }, () => 100),
    ...Array.from({ length: slowCount }, () => slowMs),
  ];
  return { samples: sampleMs.length, sampleMs, p50Ms: 100,
    p90Ms: [...sampleMs].sort((a, b) => a - b)[40] };
}
function result(samples = metric()) {
  return { ok: true, acceptanceEligible: true,
    targets: { reads: { taskGet: target }, mutations: {} },
    reads: { taskGet: samples }, mutations: {} };
}
function initial(user = result(), service = result()) {
  return { user, service };
}
test("APAC gate passes immediately when both credentials meet existing targets", () => {
  assert.deepEqual(planApacConfirmation(initial(), 45),
    { status: "passed", retest: { user: [], service: [] }, blocked: [] });
});
test("APAC gate confirms only narrow P90 miss and never trims individual tail samples", () => {
  const first = initial(result(metric(5, 263)), result());
  const plan = planApacConfirmation(first, 45);
  assert.equal(plan.status, "confirm");
  assert.deepEqual(plan.retest, { user: ["taskGet"], service: [] });
  const decision = evaluateApacConfirmation(first,
    { user: [result(metric()), result(metric())], service: [] }, plan.retest, 45);
  assert.equal(decision.status, "passed");
  assert.equal(decision.outcomes[0].samples, 135);
  assert.equal(decision.outcomes[0].passingRounds, 2);
  assert.equal(decision.outcomes[0].combinedP90Ms, 100);
});
test("APAC gate hard-blocks obvious P90 or any P50 regression without retesting", () => {
  assert.equal(planApacConfirmation(initial(result(metric(5, 300))), 45).status, "blocked");
  const bad = metric(); bad.p50Ms = 151;
  assert.equal(planApacConfirmation(initial(result(bad)), 45).status, "blocked");
});
test("APAC confirmation blocks repeat misses even when two batches make combined P90 look safe", () => {
  const first = initial(result(metric(5, 263)));
  const plan = planApacConfirmation(first, 45);
  const decision = evaluateApacConfirmation(first,
    { user: [result(metric()), result(metric(5, 263))] }, plan.retest, 45);
  assert.equal(decision.status, "blocked");
  assert.equal(decision.outcomes[0].passingRounds, 1);
});
test("APAC confirmation blocks sustained slow distribution", () => {
  const first = initial(result(metric(5, 263)));
  const plan = planApacConfirmation(first, 45);
  const decision = evaluateApacConfirmation(first,
    { user: [result(metric(5, 263)), result(metric(5, 263))] }, plan.retest, 45);
  assert.equal(decision.status, "blocked");
  assert.equal(decision.outcomes[0].combinedP90Ms, 263);
});
test("APAC gate refuses missing, partial and non-finite sample sets", () => {
  const broken = metric(5, 263); broken.sampleMs[0] = Number.NaN;
  assert.equal(planApacConfirmation(initial(result(broken)), 45).status, "blocked");
  const first = initial(result(metric(5, 263)));
  const plan = planApacConfirmation(first, 45);
  assert.throws(() => evaluateApacConfirmation(first,
    { user: [result(metric())] }, plan.retest, 45), /requires 3 batches/);
});

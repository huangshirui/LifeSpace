import assert from "node:assert/strict";
import test from "node:test";
import { extractD1Rows, resolveUniqueDatabaseId, selectUniqueAccessBackedUserId } from "./resolve-production-console-admin.mjs";

test("extracts rows from Wrangler and Cloudflare D1 JSON response shapes", () => {
  assert.deepEqual(extractD1Rows([{ success: true, results: [{ user_id: "usr_one" }] }]), [{ user_id: "usr_one" }]);
  assert.deepEqual(extractD1Rows({ success: true, results: [{ user_id: "usr_two" }] }), [{ user_id: "usr_two" }]);
  assert.deepEqual(extractD1Rows({ success: true, result: [{ success: true, results: [{ user_id: "usr_three" }] }] }), [{ user_id: "usr_three" }]);
});

test("resolves exactly one real production Identity database by name", () => {
  assert.equal(resolveUniqueDatabaseId([
    { name: "lifespace-identity-staging", uuid: "staging-id" },
    { name: "lifespace-identity", uuid: "production-id" },
  ]), "production-id");
  assert.throws(() => resolveUniqueDatabaseId([], "lifespace-identity"), /found 0/u);
  assert.throws(() => resolveUniqueDatabaseId([
    { name: "lifespace-identity", uuid: "one" },
    { name: "lifespace-identity", uuid: "two" },
  ]), /found 2/u);
});

test("selects exactly one verified Access-backed active user candidate", () => {
  assert.equal(selectUniqueAccessBackedUserId([{ user_id: "usr_owner" }]), "usr_owner");
  assert.equal(selectUniqueAccessBackedUserId([{ user_id: "usr_owner" }, { user_id: "usr_owner" }]), "usr_owner");
});

test("fails closed when no verified Access-backed user exists", () => {
  assert.throws(() => selectUniqueAccessBackedUserId([]), /exactly one active production user/u);
});

test("fails closed when multiple verified Access-backed users exist", () => {
  assert.throws(
    () => selectUniqueAccessBackedUserId([{ user_id: "usr_one" }, { user_id: "usr_two" }]),
    /found 2/u,
  );
});

test("ignores invalid identifiers rather than treating them as authority", () => {
  assert.throws(
    () => selectUniqueAccessBackedUserId([{ user_id: "owner@example.com" }, { user_id: "not-a-user" }]),
    /found 0/u,
  );
});

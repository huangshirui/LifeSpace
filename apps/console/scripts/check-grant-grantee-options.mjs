import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGrantChoice, isActiveAgent, isActiveService } from "../src/grant-grantee-options.ts";

const active = { status: "active" };
const disabled = { status: "disabled" };
assert.equal(matchesGrantChoice({ id: "agt_123", name: "Health Agent" }, " health "), true);
assert.equal(matchesGrantChoice({ id: "agt_123", name: "Health Agent" }, "AGT_123"), true);
assert.equal(matchesGrantChoice({ id: "svc_456", name: "家庭服务" }, "家庭"), true);
assert.equal(matchesGrantChoice({ id: "svc_456", name: "家庭服务" }, "agent"), false);
assert.equal(isActiveService(active, active), true);
assert.equal(isActiveService(active, disabled), false);
assert.equal(isActiveService(disabled, active), false);
assert.equal(isActiveAgent(active, { ...active, binding: active }), true);
assert.equal(isActiveAgent(disabled, { ...active, binding: active }), false);
assert.equal(isActiveAgent(active, { ...disabled, binding: active }), false);
assert.equal(isActiveAgent(active, { ...active, binding: { status: "revoked" } }), false);

const picker = readFileSync(new URL("../src/GrantGranteePicker.tsx", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../src/SpaceGrantGovernanceOverlay.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const select = readFileSync(new URL("../src/SearchableSelect.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../src/ConsoleDialog.tsx", import.meta.url), "utf8");
assert.equal((picker.match(/<SearchableSelect\b/g) ?? []).length, 2);
assert.ok(!picker.includes("<select"));
assert.ok(picker.includes('setAppId(id); setQuery(""); onChange("")'));
assert.ok(select.includes('role="combobox"') && select.includes('role="listbox"') && select.includes('role="option"'));
assert.ok(select.includes('onChange(""); onQueryChange(event.target.value)'));
assert.ok(select.includes('onChange(row.id)'));
assert.ok(select.includes('event.key === "Enter"') && select.includes('event.key === "Escape"'));
assert.ok(dialog.includes("dialog.showModal()") && dialog.includes("onCancel="));
for (const mode of ["create", "edit", "revoke"]) {
  assert.ok(overlay.includes('if (mode?.type === "' + mode + '") return <ConsoleDialog key="' + mode + '"'));
}
assert.ok(overlay.includes('return <ConsoleDialog key="list"'));
assert.ok(!overlay.includes('mode?.type === "create" &&'));
assert.ok(overlay.includes('setResourceId(id); setConfirmed(false)'));
assert.ok(overlay.includes('setPermission(event.target.value as GrantPermission); setConfirmed(false)'));
assert.ok(overlay.includes('setExpiresAt(event.target.value); setConfirmed(false)'));
assert.ok(picker.includes('current = false; window.clearTimeout(timer)'));
assert.ok(picker.includes('choice?.name ?? grant.granteeType'));
assert.ok(overlay.includes('setGranteeId(""); setConfirmed(false)'));
assert.ok(overlay.includes('setGranteeId(id); setConfirmed(false)'));
assert.ok(overlay.includes('granteeId: granteeId.trim()'));
assert.ok(overlay.includes('confirmSpaceId: spaceId'));
assert.ok(page.includes('<GrantGranteeLabel grant={grant} labels={grantLabels} />'));
console.log("Grant grantee eligibility, name/ID search and selection boundary checks passed");

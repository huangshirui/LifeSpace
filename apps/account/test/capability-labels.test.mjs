import { test } from "node:test";
import assert from "node:assert/strict";
import { displayModelName, displayOperation, displayScope } from "../public/capability-labels.js";

test("Consent shows localized business names instead of model key suffixes", () => {
  assert.equal(displayModelName({ key: "activity", name: "Activity" }), "活动");
  assert.equal(displayModelName({ key: "anniversary", name: "Anniversary" }), "纪念日");
  assert.equal(displayModelName({ key: "day_record", name: "Day Record" }), "每日记录");
  assert.equal(displayModelName({ key: "health_assessment", name: "Health Assessment" }), "健康评估");
  assert.equal(displayModelName({ key: "custom_model", name: "自定义模型" }), "自定义模型");
  assert.equal(displayModelName({ key: "custom_model", name: "Custom Model" }), "Custom Model");
});

test("Consent displays understandable operations and scopes, without changing the wire values", () => {
  assert.equal(displayOperation("read"), "可读取");
  assert.equal(displayOperation("write"), "可修改");
  assert.equal(displayOperation("manage"), "可管理");
  assert.equal(displayOperation("free_busy"), "可查看忙闲");
  assert.equal(displayScope("resources:read"), "读取信息");
  assert.equal(displayScope("resources:write"), "修改信息");
  assert.equal(displayScope("resources:manage"), "管理信息");
  assert.equal(displayScope("custom:permission"), "custom:permission");
});

test("missing display metadata has a safe fallback", () => {
  assert.equal(displayModelName({ key: "user_defined", name: "" }), "user defined");
  assert.equal(displayModelName({ key: "", name: "" }), "未命名数据类型");
});

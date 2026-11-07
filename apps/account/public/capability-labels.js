// Presentation only: never use localized labels to decide authorization.
const modelNames = Object.freeze({
  activity: "活动",
  anniversary: "纪念日",
  day_record: "每日记录",
  goal: "目标",
  habit: "习惯",
  task: "待办事项",
  event: "日程",
  person: "人物",
  health_assessment: "健康评估",
  health_concern: "健康关注",
  health_metric: "健康指标",
  health_observation: "健康观察",
  health_event: "健康事件",
  health_document: "健康文档",
  health_regimen: "健康方案",
  football_match: "足球比赛",
  football_player_performance: "球员表现",
});
const operationNames = Object.freeze({
  read: "可读取",
  write: "可修改",
  manage: "可管理",
  free_busy: "可查看忙闲",
});
const scopeNames = Object.freeze({
  "resources:read": "读取信息",
  "resources:write": "修改信息",
  "resources:manage": "管理信息",
});

export function displayModelName(model) {
  const key = typeof model?.key === "string" ? model.key : "";
  const display = typeof model?.name === "string" ? model.name.trim() : "";
  // Respect an explicit non-English model display name configured by the
  // application; use Chinese aliases for standard platform models only.
  if (display && /[^\u0000-\u007f]/u.test(display)) return display;
  return modelNames[key] || display || key.replace(/[_-]+/gu, " ") || "未命名数据类型";
}

export function displayOperation(access) {
  return operationNames[access] || "其他操作";
}

export function displayScope(scope) {
  return scopeNames[scope] || scope;
}

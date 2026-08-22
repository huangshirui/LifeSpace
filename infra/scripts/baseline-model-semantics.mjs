export const BASELINE_MODEL_SEMANTICS = Object.freeze({
  task: Object.freeze({
    route: "tasks",
    description: "Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。",
    fields: Object.freeze({
      name: "The concrete action or to-do to complete.",
      description: "Supporting details about how or why to complete the task.",
      dueDate: "The deadline date for completing the task, not a calendar time block.",
      status: "Current lifecycle state of the task.",
      assigneePersonIds: "People responsible for completing the task.",
    }),
  }),
  wish: Object.freeze({
    route: "wishes",
    description: "An aspiration, desire, or hoped-for future experience or thing that the user wants but has not committed to as a concrete task or scheduled event. Use for bucket-list items, dreams, desired purchases, and hoped-for experiences. Never use Wish as a fallback merely because its schema is broad or another model has missing fields. Examples: 想去冰岛看极光；希望以后有一台房车；想学会潜水。",
    fields: Object.freeze({
      title: "A concise statement of the aspiration or desired outcome.",
      description: "Optional detail about the aspiration and why it is desired.",
      desiredDate: "A hoped-for date, not a committed task deadline or scheduled event time.",
      status: "Current lifecycle state of the wish.",
      ownerPersonId: "The person whose aspiration this is.",
    }),
  }),
  day_record: Object.freeze({
    route: "day-records",
    description: "A date-anchored tracker for counting elapsed days, counting down to a date, or representing a recurring/cycle interval. Use for since/until counters, milestones anchored to a date, streaks, and cycle tracking. Do not use for ordinary appointments, one-off calendar occurrences, or concrete to-dos. Examples: 从今天开始戒糖；距离生日还有多少天；每28天一个周期。",
    fields: Object.freeze({
      name: "The milestone, streak, countdown, or cycle being tracked.",
      description: "Optional context about the tracked date or cycle.",
      kind: "Tracker mode: elapsed since anchorDate, countdown until anchorDate, or recurring cycle.",
      anchorDate: "The calendar date that anchors the elapsed, countdown, or cycle calculation.",
      subjectPersonId: "Optional person the tracked date or cycle belongs to.",
      cycleDays: "Length in days for a recurring cycle.",
    }),
  }),
  event: Object.freeze({
    route: "events",
    description: "A calendar occurrence that happens or is planned for a specific date or time and may occupy time or involve attendance or a location. Use for meetings, appointments, classes, matches, meals, celebrations, and other things that occur. Do not use merely because a task has a deadline. Examples: 周六上午十点足球比赛；明晚七点和王老师吃饭；8月30日体检。",
    fields: Object.freeze({
      summary: "A concise name for the calendar occurrence.",
      description: "Optional details about the occurrence.",
      location: "Where the occurrence happens, when explicitly provided.",
      isAllDay: "Whether the occurrence is date-only rather than at a specific time.",
      startAt: "Start instant for a timed occurrence.",
      endAt: "End instant for a timed occurrence when explicitly known.",
      startDate: "Start date for an all-day occurrence.",
      endDateExclusive: "Exclusive end date for an all-day occurrence.",
      attendeePersonIds: "People attending or participating in the occurrence.",
      status: "Current lifecycle state of the event.",
    }),
  }),
});

export function applyBaselineModelSemantics(definition, expected) {
  const next = structuredClone(definition);
  next.description = expected.description;
  for (const [fieldKey, description] of Object.entries(expected.fields)) {
    if (!next.fields?.[fieldKey]) {
      throw new Error(`Published model ${definition.key} is missing expected field ${fieldKey}`);
    }
    next.fields[fieldKey].description = description;
  }
  return next;
}

export function baselineModelSemanticsMatch(definition, expected) {
  if (definition.description !== expected.description) return false;
  return Object.entries(expected.fields).every(
    ([fieldKey, description]) => definition.fields?.[fieldKey]?.description === description,
  );
}

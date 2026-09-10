export const CALENDAR_VIEWING_WINDOW_QUERY_KEY = "calendar.window" as const;

export const CALENDAR_LEGACY_WINDOW_PARAMETERS = [
  "rangeStart",
  "rangeEnd",
  "dateStart",
  "dateEndExclusive",
] as const;

export const CALENDAR_VIEWING_WINDOW_PARAMETERS = [
  {
    parameter: "windowStartDate",
    type: "date",
    required: true,
    role: "window-start-date",
  },
  {
    parameter: "windowEndDateExclusive",
    type: "date",
    required: true,
    role: "window-end-date-exclusive",
  },
  {
    parameter: "viewingTimezone",
    type: "timezone",
    required: true,
    role: "viewing-timezone",
  },
] as const;

export const CALENDAR_VIEWING_WINDOW_ORDERING = {
  parameter: "sort",
  values: ["calendarStart:asc", "calendarStart:desc"],
  default: "calendarStart:asc",
  dateBasis: "viewing-timezone",
  allDayPlacement: "before-timed-within-date",
  timedOrder: "instant",
  tieBreaker: "record-id-asc",
} as const;

export function calendarViewingWindowSemanticQuery() {
  return {
    key: CALENDAR_VIEWING_WINDOW_QUERY_KEY,
    capability: "calendar" as const,
    semantics: "record-interval-overlap" as const,
    recurrenceExpansion: false as const,
    parameters: CALENDAR_VIEWING_WINDOW_PARAMETERS.map((parameter) => ({ ...parameter })),
    ordering: {
      ...CALENDAR_VIEWING_WINDOW_ORDERING,
      values: [...CALENDAR_VIEWING_WINDOW_ORDERING.values],
    },
  };
}

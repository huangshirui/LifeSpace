-- Initial publication of five Space-owned Native Baseline Models.
-- Preserve compatible older published Activity history; divergent models fail
-- on the unique active model key constraint rather than silently overwrite.
-- Typed schema uses compilePhysicalSchema's deterministic scalar/index mapping.

CREATE TABLE IF NOT EXISTS "mdl_anniversary" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "month" INTEGER NOT NULL,
  "day" INTEGER NOT NULL,
  "year" INTEGER,
  UNIQUE(space_id,record_id)
);
CREATE INDEX IF NOT EXISTS "idx_mdl_anniversary_day" ON "mdl_anniversary"(space_id,"day",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_anniversary_month" ON "mdl_anniversary"(space_id,"month",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_anniversary_name" ON "mdl_anniversary"(space_id,"name",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_anniversary_year" ON "mdl_anniversary"(space_id,"year",record_id);

CREATE TABLE IF NOT EXISTS "mdl_activity" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "startDate" TEXT,
  "endDate" TEXT,
  UNIQUE(space_id,record_id)
);
CREATE INDEX IF NOT EXISTS "idx_mdl_activity_endDate" ON "mdl_activity"(space_id,"endDate",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_activity_name" ON "mdl_activity"(space_id,"name",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_activity_startDate" ON "mdl_activity"(space_id,"startDate",record_id);

CREATE TABLE IF NOT EXISTS "mdl_goal" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "startDate" TEXT,
  "targetDate" TEXT,
  UNIQUE(space_id,record_id)
);
CREATE INDEX IF NOT EXISTS "idx_mdl_goal_name" ON "mdl_goal"(space_id,"name",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_goal_startDate" ON "mdl_goal"(space_id,"startDate",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_goal_targetDate" ON "mdl_goal"(space_id,"targetDate",record_id);

CREATE TABLE IF NOT EXISTS "mdl_person_profile" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  UNIQUE(space_id,record_id)
);
CREATE INDEX IF NOT EXISTS "idx_mdl_person_profile_key" ON "mdl_person_profile"(space_id,"key",record_id);

CREATE TABLE IF NOT EXISTS "mdl_habit" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "intervalDays" INTEGER NOT NULL,
  "lastCheckInDate" TEXT,
  "streakStartDate" TEXT,
  UNIQUE(space_id,record_id)
);
CREATE INDEX IF NOT EXISTS "idx_mdl_habit_intervalDays" ON "mdl_habit"(space_id,"intervalDays",record_id);
CREATE INDEX IF NOT EXISTS "idx_mdl_habit_name" ON "mdl_habit"(space_id,"name",record_id);

-- Known pre-review Activity snapshots (English / Chinese field descriptions)
-- differ only in documentation and are safely compatible with the baseline.
UPDATE model_definitions SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='activity' AND state='published' AND schema_hash IN (
  'd15cfe27ab1d903197e54a494e99d79be01fec052b04807c9708b788f10127b0',
  'c504967da1984b528ef99d263297e9620365c9acc5fefe7aa6658b1019b42b04'
);

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT 'mdl_catalog_anniversary_20261021','anniversary','anniversary',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='anniversary'),0)+1,
  'published',1,'{"access":["read","write"],"definitionVersion":1,"description":"A date that commemorates a meaningful occasion each year, with or without a known original year. Use for birthdays, wedding anniversaries, and personal milestones. Do not use for a planned celebration or appointment; use Event instead. Examples: 爸妈结婚纪念日（10月8日）；小朋友生日（3月12日）。","display":{"plural":"Anniversaries","singular":"Anniversary"},"fields":{"day":{"description":"Day of the anniversary within its month; use a real calendar day for the chosen month.","maximum":31,"minimum":1,"required":true,"title":"Day","type":"integer"},"description":{"description":"Optional background about the occasion and why it matters to the people involved.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"month":{"description":"Month in which the anniversary falls each year (1–12), whether or not its original year is known.","maximum":12,"minimum":1,"required":true,"title":"Month","type":"integer"},"name":{"description":"The occasion being remembered, such as a wedding anniversary, birthday, or first day of school.","maxLength":150,"minLength":1,"required":true,"title":"Name","type":"string"},"personIds":{"description":"People connected to the occasion; may include several people, such as both partners in a wedding anniversary.","title":"People","type":"person_list"},"year":{"description":"Original year of the occasion when known; omit it for anniversaries known only by month and day.","maximum":9999,"minimum":1,"nullable":true,"title":"Original Year","type":"integer"}},"key":"anniversary","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["personIds","month","day","year"],"searchable":["name","description"],"sortable":["month","day","name"]},"referenceLabel":{"field":"name"}}','13c2b7d6f6151b7af794717d38ee1c5d187f918824647519fe195740f9e635eb',
  CASE WHEN EXISTS(SELECT 1 FROM model_definitions WHERE model_key='anniversary') THEN 'compatible' ELSE 'initial' END,
  'service','svc_lifespace_bootstrap','LifeSpace schema 71 baseline models'
WHERE NOT EXISTS(SELECT 1 FROM model_definitions WHERE model_key='anniversary' AND state='published' AND schema_hash='13c2b7d6f6151b7af794717d38ee1c5d187f918824647519fe195740f9e635eb');

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT 'mdl_catalog_activity_20261021','activity','activity',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='activity'),0)+1,
  'published',1,'{"access":["read","write"],"definitionVersion":1,"description":"A purposeful activity or undertaking that may extend over several days and involve multiple people or plans. Use for trips, camps, competitions, and other shared endeavors. Do not use for a single appointment (Event) or a desired result (Goal). Examples: 国庆家庭旅行；秋季校园足球联赛。","display":{"plural":"Activities","singular":"Activity"},"fields":{"attendeePersonIds":{"description":"People who take part in or are associated with the activity; an activity may have no named participants.","title":"Attendees","type":"person_list"},"description":{"description":"Optional purpose, plans, or context that explains what this activity involves.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"endDate":{"description":"Last calendar date of the activity, if an end date is known.","nullable":true,"title":"End Date","type":"date"},"name":{"description":"The name by which people recognize the activity, such as a trip, training camp, or football competition.","maxLength":150,"minLength":1,"required":true,"title":"Name","type":"string"},"startDate":{"description":"First calendar date of the activity, if a start date is known.","nullable":true,"title":"Start Date","type":"date"}},"key":"activity","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["attendeePersonIds","startDate","endDate"],"searchable":["name","description"],"sortable":["startDate","endDate","name"]},"referenceLabel":{"field":"name"},"semanticRelations":{"outgoing":["relates_to"]}}','e2dc382ff49a6fc16edf6fe9a0ae988314f357986634116f4d6173b97ce5c3db',
  CASE WHEN EXISTS(SELECT 1 FROM model_definitions WHERE model_key='activity') THEN 'compatible' ELSE 'initial' END,
  'service','svc_lifespace_bootstrap','LifeSpace schema 71 baseline models'
WHERE NOT EXISTS(SELECT 1 FROM model_definitions WHERE model_key='activity' AND state='published' AND schema_hash='e2dc382ff49a6fc16edf6fe9a0ae988314f357986634116f4d6173b97ce5c3db');

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT 'mdl_catalog_goal_20261021','goal','goal',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='goal'),0)+1,
  'published',1,'{"access":["read","write"],"definitionVersion":1,"description":"An outcome that one or more people intend to achieve, with optional starting and target dates. Use for learning, health, family, or personal aspirations. Do not use for a single action (Task) or something scheduled to occur (Event). Examples: 年内通过钢琴五级；每年读完二十本书。","display":{"plural":"Goals","singular":"Goal"},"fields":{"description":{"description":"Optional motivation, success criteria, or context explaining what achieving the goal means.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"name":{"description":"The outcome being sought, stated as something people want to accomplish.","maxLength":150,"minLength":1,"required":true,"title":"Name","type":"string"},"startDate":{"description":"Calendar date when pursuit of the goal begins, if known.","nullable":true,"title":"Start Date","type":"date"},"subjectPersonIds":{"description":"People pursuing or sharing the goal; this may be an individual or several family members.","title":"People","type":"person_list"},"targetDate":{"description":"Desired date by which the goal should be achieved; it is not an appointment or scheduled event.","nullable":true,"title":"Target Date","type":"date"}},"key":"goal","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["subjectPersonIds","startDate","targetDate"],"searchable":["name","description"],"sortable":["targetDate","name"]},"referenceLabel":{"field":"name"},"semanticRelations":{"outgoing":["relates_to"]}}','e5b9c865cdb43f054b3366b1028c15ebd5b0e72ba525b7e76b0cfb93140ce93e',
  CASE WHEN EXISTS(SELECT 1 FROM model_definitions WHERE model_key='goal') THEN 'compatible' ELSE 'initial' END,
  'service','svc_lifespace_bootstrap','LifeSpace schema 71 baseline models'
WHERE NOT EXISTS(SELECT 1 FROM model_definitions WHERE model_key='goal' AND state='published' AND schema_hash='e5b9c865cdb43f054b3366b1028c15ebd5b0e72ba525b7e76b0cfb93140ce93e');

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT 'mdl_catalog_person_profile_20261021','person_profile','person_profile',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='person_profile'),0)+1,
  'published',1,'{"access":["read","write"],"definitionVersion":1,"description":"A personal attribute, preference, or background fact that helps describe a known person. Use for details such as education, interests, sizes, or preferences. Do not use for identity and access, dated experiences, or diary entries. Examples: 毕业学校=北京大学；喜欢的运动=足球。","display":{"plural":"Person Profile Entries","singular":"Person Profile"},"fields":{"key":{"description":"Name of the attribute or fact, such as 毕业学校, 服装尺码, or 喜欢的运动.","maxLength":120,"minLength":1,"required":true,"title":"Key","type":"string"},"personId":{"description":"The person whom this attribute or background fact describes.","immutable":true,"required":true,"title":"Person","type":"person"},"value":{"description":"The person''s value or explanation for this attribute, such as 北京大学, M, or 足球.","maxLength":5000,"minLength":1,"required":true,"title":"Value","type":"text"}},"key":"person_profile","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["personId","key"],"searchable":["key","value"],"sortable":["key"]},"referenceLabel":{"field":"key"}}','cffc6f14db9637234d8bdd8680e05fa06284e37ec15595cdf670a7a49d7ccb11',
  CASE WHEN EXISTS(SELECT 1 FROM model_definitions WHERE model_key='person_profile') THEN 'compatible' ELSE 'initial' END,
  'service','svc_lifespace_bootstrap','LifeSpace schema 71 baseline models'
WHERE NOT EXISTS(SELECT 1 FROM model_definitions WHERE model_key='person_profile' AND state='published' AND schema_hash='cffc6f14db9637234d8bdd8680e05fa06284e37ec15595cdf670a7a49d7ccb11');

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT 'mdl_catalog_habit_20261021','habit','habit',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='habit'),0)+1,
  'published',1,'{"access":["read","write"],"capabilities":{"checkIn":{"intervalDaysField":"intervalDays","lastCheckInDateField":"lastCheckInDate","streakStartDateField":"streakStartDate"}},"defaults":{"intervalDays":1},"definitionVersion":1,"description":"A repeated behavior someone intends to maintain through actual check-ins over time. Use for practices such as reading, exercise, or music practice when ongoing consistency matters. Do not use for a one-off Task, a scheduled Event, an elapsed-day counter (DayRecord), or a desired outcome (Goal). Examples: 每天读书30分钟；至少每两天运动一次。","display":{"plural":"Habits","singular":"Habit"},"fields":{"description":{"description":"Optional context, instructions, or motivation that explains what practicing the habit involves.","maxLength":3000,"nullable":true,"title":"Description","type":"text"},"intervalDays":{"description":"The maximum allowed calendar-day gap between two check-ins without interrupting the streak. Use 1 for daily check-ins, or 2 when up to two calendar days may pass between them. This choice is fixed after creation.","immutable":true,"maximum":365,"minimum":1,"required":true,"title":"Check-in Interval (days)","type":"integer"},"lastCheckInDate":{"description":"The latest calendar date on which this habit was checked in. Empty before the first check-in; dates follow the Space''s local calendar.","nullable":true,"readOnly":true,"title":"Last Check-in Date","type":"date"},"name":{"description":"The behavior or practice a person intends to maintain over time, such as reading for 30 minutes or practicing piano.","maxLength":150,"minLength":1,"required":true,"title":"Name","type":"string"},"streakStartDate":{"description":"The first check-in date of the most recently recorded uninterrupted sequence. When the allowed gap is exceeded, the next check-in begins a new sequence.","nullable":true,"readOnly":true,"title":"Streak Start Date","type":"date"}},"key":"habit","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["intervalDays"],"searchable":["name","description"],"sortable":["name"]},"referenceLabel":{"field":"name"},"semanticRelations":{"outgoing":["relates_to"]}}','c2684560f1241e5496f1575cbe9dfc67068bb84f4c7c3b172d3676b27bada369',
  CASE WHEN EXISTS(SELECT 1 FROM model_definitions WHERE model_key='habit') THEN 'compatible' ELSE 'initial' END,
  'service','svc_lifespace_bootstrap','LifeSpace schema 71 baseline models'
WHERE NOT EXISTS(SELECT 1 FROM model_definitions WHERE model_key='habit' AND state='published' AND schema_hash='c2684560f1241e5496f1575cbe9dfc67068bb84f4c7c3b172d3676b27bada369');

UPDATE model_registry_state SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='71' WHERE key='schema_version';

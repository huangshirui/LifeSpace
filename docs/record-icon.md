# Native Record Icon / 原生记录图标

## Contract / 契约

An optional, per-Record presentation value; **not a Model Definition field** and not a separate user-defined capability. Native records return `presentation: { icon }`, where `icon` is null, `{ "type": "emoji", "value": "⚽" }`, or `{ "type": "image", "fileId": "fil_..." }`. The `presentation` name is reserved in Model Definition Fields. An absent icon is null; clients may choose their own default Emoji. **External records are not writable** through this feature in V1.

Read: existing model GET/LIST/query (bounded projection of `resource_records.icon_json`, no per-record hydration D1 queries). Update: `PATCH /api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}/icon` body `{ "version": 3, "icon": { "type": "emoji", "value": "📘" } }`. This is a governed Record update, requires model+Space+Record authorization and optimistic concurrency, increments `version`, and emits change history. Null clears the icon.

## Image / 图片

Only static PNG, JPEG, WebP. **Service-side hard limits 256 KiB and <=512×512 pixels**, plus MIME and signature checks. SVG, remote URLs and base64 are not accepted. Users resize/compress before upload; the server verifies independently.

Use existing `POST /file-uploads` scoped to target `modelKey`, existing `recordId`, and reserved `fieldKey: "__record_icon"`; complete the signed R2 upload using File session as usual, then assign the returned ready `fil_*` in the Record Icon update. File metadata and link authority are in D1; actual bytes in private R2. Download via `POST /file-downloads` scoped to the same `modelKey`, `recordId`, reserved `fieldKey`, and assigned `fileId`; returned R2 signed URL is short-lived, never stored as durable identity. Old replaced Files may be deleted through existing authorized File deletion lifecycle after detachment. No direct R2 credentials in client interfaces.

## DayRecord breaking cutover / 一次性迁移

Migration 0069 adds shared `resource_records.icon_json`, copies existing nonempty `mdl_day_record.icon` into `{type:"emoji",value}`, then removes `mdl_day_record.icon`. The DayRecord baseline catalog removes that model field; Registry publishes version 6, breaking hash `3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7`. Verify historical icon content before applying migration, back up D1, verify counts and hashes afterward. Do not keep a dual-write or legacy `data.icon` alias.

Old HomeMew Mini clients may lose all Days create/edit operations during the WeChat review window; this is an expressly accepted business tradeoff. Other models/operations must continue working. HomeMew integration: [HomeMew #132](https://github.com/huangshirui/HomeMew/issues/132), platform tracking: [LifeSpace #390](https://github.com/huangshirui/LifeSpace/issues/390).

## Release / 发布状态

**Development / Not production.** A merged PR or passing CI does not imply staging/production deployment; verify actual R2 capabilities, data migration, policies and performance in staging before any manually approved production migration.

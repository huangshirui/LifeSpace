# Native Record Icon / 原生记录图标

## Contract / 契约

An optional, per-Record presentation value; **not a Model Definition field** and not a separate user-defined capability. Native records may return `presentation: { icon }`, where `icon` is `{ "type": "emoji", "value": "⚽" }` or `{ "type": "image", "fileId": "fil_..." }`. **The entire `presentation` property is omitted when no icon exists**; it is not a required read field. The `presentation` name is reserved in Model Definition Fields. Consumers may choose their own default Emoji. **External records are not writable** through this feature in V1.

Read: existing model GET/LIST/query, using existing typed storage projection (no per-record extra D1 I/O).

**Write with one Record request**: ordinary `POST /api/v1/spaces/{spaceId}/models/{modelKey}/records` and `PATCH /.../records/{recordId}` optionally accept `presentation: { icon: { "type": "emoji", "value": "📘" } }`. PATCH also requires existing `version`; omitted presentation **must not change existing Icon**. Explicit `presentation: { icon: null }` clears it. If metadata is omitted on CREATE, do not persist/return a presentation object.

Business fields and optional Icon are written atomically by **the same D1 mutation batch and Change History**, with exactly one Record Version increment; there is no separate `PATCH /records/{id}/icon` route. Validation and authorization are performed by the governed Record mutation path, not a presentation-specific bypass. Normal record request validation rejects undeclared fields aside from reserved presentation.


## Image / 图片

Only static PNG, JPEG, WebP. **Service-side hard limits 256 KiB and <=512×512 pixels**, plus MIME and signature checks. SVG, remote URLs and base64 are not accepted. Users resize/compress before upload; the server verifies independently.

Use existing `POST /file-uploads` scoped to `spaceId`, `modelKey`, and reserved `fieldKey: "__record_icon"` **without a recordId** for pre-creation image upload. This creates a bounded unattached File; complete the signed R2 upload, then set its stable `fil_*` in the same ordinary Record CREATE request. For existing records it is also legal to upload with their `recordId`, then set the File reference in the same ordinary PATCH as business updates. File image binding verifies Space, Model, owner/application and readiness, and the D1 link participates in the Record mutation transaction. If Record creation is cancelled after upload, the pending unlinked File must remain deletable via File lifecycle; orphan cleanup is a separate operational concern, not a hidden second Record write. File metadata and link authority are in D1; actual bytes in private R2. Download via `POST /file-downloads` scoped to the same `modelKey`, `recordId`, reserved `fieldKey`, and assigned `fileId`; returned R2 signed URL is short-lived, never stored as durable identity. Old replaced Files may be deleted through existing authorized File deletion lifecycle after detachment. No direct R2 credentials in client interfaces.

## DayRecord breaking cutover / 一次性迁移

Migration 0069 adds shared `resource_records.icon_json`, copies existing nonempty `mdl_day_record.icon` into `{type:"emoji",value}`, then removes `mdl_day_record.icon`. The DayRecord baseline catalog removes that model field; Registry publishes version 6, breaking hash `3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7`. Verify historical icon content before applying migration, back up D1, verify counts and hashes afterward. Do not keep a dual-write or legacy `data.icon` alias.

Old HomeMew Mini clients may lose all Days create/edit operations during the WeChat review window; this is an expressly accepted business tradeoff. Other models/operations must continue working. HomeMew integration: [HomeMew #132](https://github.com/huangshirui/HomeMew/issues/132), platform tracking: [LifeSpace #390](https://github.com/huangshirui/LifeSpace/issues/390).

## Release / 发布状态

**Development / Not production.** A merged PR or passing CI does not imply staging/production deployment; verify actual R2 capabilities, data migration, policies and performance in staging before any manually approved production migration.

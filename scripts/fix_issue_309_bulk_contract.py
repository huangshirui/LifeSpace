from pathlib import Path

path = Path('apps/core/src/model-contract.ts')
text = path.read_text()
old = '''  schemas.BulkMutationRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operations"],
    properties: {
      operations: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/BatchOperation" } },
    },
  };'''
new = '''  schemas.BulkOperation = {
    oneOf: [
      ...createVariants,
      ...updateVariants,
      { $ref: "#/components/schemas/BatchDeleteOperation" },
    ],
    description: "One non-atomic Bulk create/update/delete item. Items share one bounded transport/performance request but are validated and committed independently; one item failure does not roll back another successful item. One existing record may appear at most once in a Bulk. Update/delete version is optional: supplied values enforce caller-known optimistic concurrency; omitted values are resolved from the current set-wise target snapshot before that item commits.",
  };
  schemas.BulkMutationRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operations"],
    properties: {
      operations: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/BulkOperation" } },
    },
  };'''
if text.count(old) != 1:
    raise SystemExit(f'expected one BulkMutationRequest marker, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('Bulk generated contract now owns a non-atomic BulkOperation schema')

# Packages Agent Instructions

`packages/` contains reusable platform artifacts with concrete consumers.

## Rules

- Packages must not own runtime data or deployment resources.
- Prefer generation from canonical service contracts over duplicated handwritten schemas.
- Do not create a new shared package merely to avoid a small local duplication; require a clear platform consumer and stable abstraction.
- Package releases must make compatibility and source contract version explicit.
- Generated files must be reproducible and clearly identified as generated.
- Read the nested package `AGENTS.md` before changing a package.

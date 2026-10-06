# GitHub Actions Agent Instructions

These rules apply to `.github/**` and supplement the repository-root `AGENTS.md`.

## Environment deployment safety

- `staging-deploy.yml` and `production-deploy.yml` are canonical environment-changing workflows and must remain explicit repository-owner actions.
- Never add `push`, `pull_request`, `schedule`, `workflow_run`, `repository_dispatch`, or another automatic trigger to either canonical deploy workflow unless the user explicitly changes this policy.
- Never create a helper/closeout workflow, CI job, script, GitHub API call, `gh workflow run`, reusable-workflow chain, or `GITHUB_TOKEN` path that dispatches either canonical deploy workflow on the user's behalf.
- `workflow_dispatch` alone is not proof of human intent: API/CLI and another workflow can dispatch it. Preserve the owner/actor/ref validation gates in the canonical deploy workflows unless the user explicitly approves a different human-approval mechanism.
- Production must additionally preserve its explicit `DEPLOY_PRODUCTION` confirmation input. This confirmation is defense in depth, not a substitute for the owner/actor gate.
- Normal CI may validate deployment configuration with non-mutating checks or dry runs, but must not migrate, deploy, publish, or otherwise mutate staging/production resources.
- If automation needs evidence from staging or production, consume existing deployment/status evidence; do not auto-trigger an environment deployment to manufacture that evidence.
- Any proposed change to these deployment-trigger or approval boundaries must be surfaced to the user before implementation and recorded in the LifeSpace `99 · 架构演进与决策日志` when accepted.

from pathlib import Path
import runpy
import subprocess

ROOT = Path(__file__).resolve().parents[1]
runpy.run_path(str(ROOT / "scripts/fix_issue_307_staging_acceptance.py"), run_name="__main__")

# The Actions GITHUB_TOKEN has contents:write but no workflows permission.
# Keep the already-validated verifier source changes, while restoring workflow
# summary-only edits; those two lines are applied separately via the GitHub
# connector after this verified commit lands.
subprocess.run([
    "git", "checkout", "HEAD", "--",
    ".github/workflows/staging-deploy.yml",
    ".github/workflows/lifespace-console-staging-deploy.yml",
], cwd=ROOT, check=True)

print("#307 staging acceptance verifier changes applied without workflow-file edits")

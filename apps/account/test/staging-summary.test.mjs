import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow=readFileSync(new URL("../../../.github/workflows/lifespace-account-staging-deploy.yml",import.meta.url),"utf8");

test("Staging rollout summary preserves literal Markdown backticks instead of executing shell substitutions",()=>{
  const marker="      - name: Staging rollout summary\n";
  const offset=workflow.indexOf(marker);
  assert.ok(offset>=0,"summary step is present");
  const block=workflow.slice(offset).match(/        run: \|\n([\s\S]*)$/u);
  assert.ok(block,"summary step has a multiline shell script");
  const script=block[1].split("\n").map(line=>line.startsWith("          ")?line.slice(10):line).join("\n");
  const dir=mkdtempSync(join(tmpdir(),"account-summary-"));
  try{
    const file=join(dir,"summary.md");
    const result=spawnSync("bash",["-euo","pipefail","-c",script],{
      encoding:"utf8",env:{...process.env,GITHUB_STEP_SUMMARY:file},
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stderr,"");
    const summary=readFileSync(file,"utf8");
    assert.match(summary,/- Worker: `lifespace-account-staging`/u);
    assert.match(summary,/- Domain: `account-staging\.aisr\.online`/u);
    assert.match(summary,/issues #499 and #514/u);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

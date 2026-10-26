import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyReleaseCandidate} from './verify-release-candidate.mjs';
const sha='a'.repeat(40),head='b'.repeat(40),repository='owner/repo';
function fixture() {
 const pr={number:1,merged_at:'2026-10-26',merge_commit_sha:sha,base:{ref:'main'},head:{sha:head,repo:{full_name:repository}}};
 const check={name:'check',head_sha:head,app:{slug:'github-actions'},status:'completed',conclusion:'success'};
 const run={head_sha:sha,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/staging-deploy.yml',status:'completed',conclusion:'success'};
 const input={repository,sha,branch:'main',event:'workflow_dispatch',environment:'production',requiredCheck:'check',stagingWorkflow:'staging-deploy.yml',request:async p=>p.includes('/pulls?')?[pr]:p.includes('/check-runs?')?{check_runs:[check]}:{workflow_runs:[run]}};
 return {pr,check,run,input};
}
test('promotes only exact merged PR with required CI and exact-candidate staging success',async()=>{const f=fixture();assert.equal((await verifyReleaseCandidate(f.input)).sha,sha);});
test('rejects direct pushes, wrong branches, unmerged and foreign PRs',async()=>{
 for(const mutate of [f=>f.input.event='push',f=>f.input.branch='feature',f=>f.pr.merged_at=null,f=>f.pr.merge_commit_sha=head,f=>f.pr.head.repo.full_name='fork/repo']) {
  const f=fixture();mutate(f);await assert.rejects(()=>verifyReleaseCandidate(f.input));
 }
});
test('rejects missing, stale, failed, running or spoofed required CI',async()=>{
 for(const mutate of [f=>f.check.name='other',f=>f.check.head_sha=sha,f=>f.check.conclusion='failure',f=>f.check.status='in_progress',f=>f.check.app.slug='external']) {
  const f=fixture();mutate(f);await assert.rejects(()=>verifyReleaseCandidate(f.input),/required CI/);
 }
});
test('rejects skipped, failed, wrong-candidate, wrong-workflow and nonmanual staging',async()=>{
 for(const mutate of [f=>f.run.conclusion='skipped',f=>f.run.conclusion='failure',f=>f.run.head_sha=head,f=>f.run.path='.github/workflows/other.yml',f=>f.run.event='push']) {
  const f=fixture();mutate(f);await assert.rejects(()=>verifyReleaseCandidate(f.input),/exact candidate/);
 }
});
test('staging still requires merged PR and CI but never requires a production deployment',async()=>{const f=fixture();f.input.environment='staging';f.input.request=async p=>{assert.ok(!p.includes('/actions/'));return p.includes('/pulls?')?[f.pr]:{check_runs:[f.check]};};await verifyReleaseCandidate(f.input);});
test('API failures and malformed evidence fail closed',async()=>{const f=fixture();f.input.request=async()=>{throw new Error('unavailable');};await assert.rejects(()=>verifyReleaseCandidate(f.input),/unavailable/);});

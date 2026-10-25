import {fileURLToPath} from 'node:url';
import path from 'node:path';

/** Read-only, fail-closed evidence. Never dispatches, merges or deploys. */
export async function verifyReleaseCandidate({repository,sha,branch,event,environment,requiredCheck,stagingWorkflow,request}) {
 if(branch!=='main'||event!=='workflow_dispatch')throw new Error('Release requires manual dispatch from main');
 if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Invalid immutable release context');
 if(!['staging','preview','production'].includes(environment))throw new Error('Unknown release environment');
 const prefix='/repos/'+repository;
 const prs=await request(prefix+'/commits/'+sha+'/pulls?per_page=100');
 const pr=prs.find(x=>x.merged_at&&x.merge_commit_sha===sha&&x.base?.ref==='main'&&x.head?.repo?.full_name===repository);
 if(!pr?.head?.sha)throw new Error('Candidate must be the exact merge commit of a merged same-repository PR');
 const checks=await request(prefix+'/commits/'+pr.head.sha+'/check-runs?filter=latest&per_page=100');
 const required=checks.check_runs.filter(x=>x.name===requiredCheck);
 if(!required.length||required.some(x=>x.head_sha!==pr.head.sha||x.app?.slug!=='github-actions'||x.status!=='completed'||x.conclusion!=='success'))throw new Error('Merged PR required CI is not successful');
 if(environment==='production') {
  if(!/^[a-z0-9-]+\.yml$/.test(stagingWorkflow??''))throw new Error('Explicit staging workflow required');
  const runs=await request(prefix+'/actions/workflows/'+stagingWorkflow+'/runs?branch=main&event=workflow_dispatch&head_sha='+sha+'&per_page=100');
  if(!runs.workflow_runs.some(x=>x.head_sha===sha&&x.head_branch==='main'&&x.event==='workflow_dispatch'&&x.path==='.github/workflows/'+stagingWorkflow&&x.status==='completed'&&x.conclusion==='success'))throw new Error('Production requires successful staging/preview of the exact candidate SHA');
 }
 return {sha,pr:pr.number,ciHead:pr.head.sha,environment};
}

export async function runReleaseGate({requiredCheck,stagingWorkflow},environment=process.argv[2]) {
 const token=process.env.GH_TOKEN;
 if(!token)throw new Error('Read-only GitHub token is required for release evidence');
 const request=async endpoint=>{
  const response=await fetch('https://api.github.com'+endpoint,{headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,'x-github-api-version':'2022-11-28'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Release evidence unavailable: HTTP '+response.status);
  return response.json();
 };
 const evidence=await verifyReleaseCandidate({repository:process.env.GITHUB_REPOSITORY,sha:process.env.GITHUB_SHA,branch:process.env.GITHUB_REF_NAME,event:process.env.GITHUB_EVENT_NAME,environment,requiredCheck,stagingWorkflow,request});
 console.log('Release provenance verified: '+JSON.stringify(evidence));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 // File is copied independently into each repository; the explicit CI names
 // distinguish their established check contracts without sharing runtime state.
 const platform=process.env.GITHUB_REPOSITORY==='huangshirui/LifeSpace';
 const backend=process.argv[3]==='backend';
 const consoleApp=process.argv[3]==='console';
 await runReleaseGate({requiredCheck:platform?'check':backend?'check':'Test, typecheck and build HomeMew Web',stagingWorkflow:platform?(consoleApp?'lifespace-console-staging-deploy.yml':'staging-deploy.yml'):backend?'backend-staging-deploy.yml':'web-preview-deploy.yml'});
}

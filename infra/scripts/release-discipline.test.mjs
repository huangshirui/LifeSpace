import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
test('platform and Console deploys pin candidate and verify provenance before mutation',()=>{
 for(const name of ['staging-deploy.yml','production-deploy.yml','lifespace-console-staging-deploy.yml','lifespace-console-production-deploy.yml']){
  const source=fs.readFileSync(new URL('../../.github/workflows/'+name,import.meta.url),'utf8');
  assert.match(source,/ref: \$\{\{ github.sha \}\}/,name);
  assert.match(source,/verify-release-candidate.mjs/,name);assert.match(source,/GH_TOKEN: \$\{\{ github.token \}\}/,name);
  const gate=source.indexOf('verify-release-candidate.mjs');
  const mutation=source.search(/wrangler deploy|db:migrate|prepare-production-console|prepare-staging-console/);
  assert.ok(gate>=0&&(mutation<0||gate<mutation),name);
  assert.doesNotMatch(source,/^  push:/m,name);
 }
});

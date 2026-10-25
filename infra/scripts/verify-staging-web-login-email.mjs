import assert from 'node:assert/strict';
const base=process.env.LIFESPACE_IDENTITY_STAGING_URL;
const user=process.env.LIFESPACE_STAGING_SMOKE_USER_ID;
const application=process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET;
if(base!=='https://auth-staging.aisr.online'||!user||!application)throw new Error('Isolated staging smoke context required');
async function request(path,{method='GET',bearer,body}={}){
 const response=await fetch(base+path,{method,headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {status:response.status,payload:await response.json()};
}
async function token(scopes){const r=await request('/internal/v1/tokens',{method:'POST',bearer:application,body:{subjectId:user,scopes}});assert.equal(r.status,200);const value=r.payload.data.accessToken;assert.ok(value);console.log('::add-mask::'+value);return value;}
const write=await token(['profile:read','profile:write']),read=await token(['profile:read']);
const path='/api/v1/me/web-login';
assert.equal((await request(path)).status,401);
assert.equal((await request(path,{method:'PATCH',bearer:read,body:{email:'denied@example.invalid',version:0}})).status,403);
const initial=await request(path,{bearer:write});assert.equal(initial.status,200);assert.equal(initial.payload.data.version,0);
const email='mailbox-'+process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT+'@example.invalid';
const save=await request(path,{method:'PATCH',bearer:write,body:{email,version:0}});assert.equal(save.status,200);assert.equal(save.payload.data.version,1);
const current=await request(path,{bearer:write});assert.equal(current.payload.data.email,email);assert.equal(current.payload.data.linked,false);assert.equal(current.payload.data.status,'pending');
assert.equal((await request(path,{method:'PATCH',bearer:write,body:{email,version:0}})).payload.error.code,'EMAIL_VERSION_CONFLICT');
const race=await Promise.all(['a','b'].map(x=>request(path,{method:'PATCH',bearer:write,body:{email:x+'-'+email,version:1}})));assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
const updated=await request(path,{bearer:write});assert.equal(updated.payload.data.version,2);
assert.equal((await request('/internal/v1/access/session-check',{method:'POST',bearer:application,body:{accessAssertion:'invalid',email:updated.payload.data.email}})).status,401);
assert.equal((await request('/api/v1/me/access-link-challenges/alc_'+'a'.repeat(64)+'/confirm',{method:'POST',bearer:write,body:{}})).status,409);
console.log('Staging mailbox GET/PATCH, current authority, scope denial, optimistic concurrency, invalid Access assertion and expired challenge denial passed.');

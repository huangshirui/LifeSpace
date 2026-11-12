import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isOrdinaryPublicIp, parseClientUrl, resolvePublicAddresses,
  pinnedRequestOptions, fetchPublicCimd } from "../lib/public-https.mjs";
import { createHandler } from "../api/cimd.mjs";

const CLIENT = "https://client.example.com/oauth/client.json";
const SECRET = "a".repeat(64);
const DOC = JSON.stringify({client_id:CLIENT, client_name:"Synthetic Client",
  redirect_uris:["https://client.example.com/callback"]});
const PUBLIC4 = "8.8.8.8";
const PUBLIC6 = "2606:4700::1111";
function dns(a, aaaa) {
  let cancelled = false;
  return {
    async resolve4() { return a; },
    async resolve6() { return aaaa; },
    cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
  };
}
function fakeRequest(calls, {status=200, body=DOC, peer, contentType="application/json", encoding,
  contentLength, authorized=true} = {}) {
  return (options, onResponse) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const socket = new EventEmitter();
      socket.remoteAddress = peer ?? options.hostname;
      socket.authorized = authorized;
      req.emit("socket", socket);
      socket.emit("secureConnect");
      const response = new EventEmitter();
      response.socket = socket;
      response.statusCode = status;
      response.headers = {"content-type":contentType, ...(encoding ? {"content-encoding":encoding} : {}),
        ...(contentLength ? {"content-length":String(contentLength)} : {})};
      response.destroy = () => {};
      onResponse(response);
      response.emit("data", Buffer.from(body));
      response.emit("end");
    });
    return req;
  };
}

test("rejects IPv4 and IPv6 IANA special-use ranges and alternative representations", () => {
  for (const address of [
    "0.0.0.0","10.0.0.1","100.64.0.1","127.0.0.1","169.254.1.1","172.16.0.1",
    "192.0.0.9","192.0.2.1","192.31.196.1","192.52.193.1","192.88.99.1","192.168.0.1",
    "192.175.48.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","240.0.0.1","255.255.255.255",
    "::","::1","::ffff:127.0.0.1","::ffff:8.8.8.8","64:ff9b::7f00:1","100::1",
    "2001::1","2001:db8::1","2002:7f00:1::1","2620:4f:8000::1","3fff::1",
    "5f00::1","fc00::1","fd00::1","fe80::1","fe80::1%eth0","ff00::1",
    "127.1","2130706433","0x7f000001","example.com",
  ]) assert.equal(isOrdinaryPublicIp(address),false,address);
  for (const address of [PUBLIC4,"1.1.1.1","104.16.0.1",PUBLIC6,"2001:4860::8888"])
    assert.equal(isOrdinaryPublicIp(address),true,address);
});
test("only canonical public HTTPS document IDs are accepted", () => {
  assert.equal(parseClientUrl(CLIENT)?.hostname,"client.example.com");
  for (const value of ["http://client.example.com/a","https://localhost/a","https://127.0.0.1/a",
    "https://[::1]/a","https://client.local/a","https://a.onion/a","https://a.internal/a",
    "https://user:pass@client.example.com/a", "https://client.example.com:8443/a",
    "https://client.example.com/",CLIENT+"?x=1",CLIENT+"#fragment","https://client.example.com./a"])
    assert.equal(parseClientUrl(value),null,value);
});
test("DNS validates BOTH A and AAAA sets, rejects mixed answers without connecting", async () => {
  const good = dns([PUBLIC4],[PUBLIC6]);
  assert.deepEqual(await resolvePublicAddresses("client.example.com",good),[PUBLIC4,PUBLIC6]);
  assert.equal(good.cancelled,true);
  for (const [a,aaaa] of [[[PUBLIC4,"10.0.0.1"],[]],[[PUBLIC4],["fd00::1"]],
    [[],["::ffff:127.0.0.1"]],[[],[]],[Array(33).fill(0).map((_,i)=>"8.8.8."+i),[]]]) {
    const resolver = dns(a,aaaa);
    await assert.rejects(resolvePublicAddresses("client.example.com",resolver));
    assert.equal(resolver.cancelled,true);
  }
  let calls = 0;
  await assert.rejects(fetchPublicCimd(CLIENT,{resolve:async()=>[PUBLIC4,"10.0.0.1"],
    request:()=>{calls++;throw Error("must not connect");}}));
  assert.equal(calls,0);
});
test("DNS is resolved once and TLS connects to the verified literal IP with original Host/SNI", async () => {
  const calls = [];
  let resolutions = 0;
  const raw = await fetchPublicCimd(CLIENT,{
    resolve:async()=>{resolutions++;return resolutions===1?[PUBLIC4]:["127.0.0.1"];},
    request:fakeRequest(calls),
  });
  assert.equal(raw,DOC);
  assert.equal(resolutions,1);
  assert.equal(calls.length,1);
  const opts = calls[0];
  assert.equal(opts.hostname,PUBLIC4);
  assert.equal(opts.family,4);
  assert.equal(opts.port,443);
  assert.equal(opts.servername,"client.example.com");
  assert.equal(opts.headers.Host,"client.example.com");
  assert.equal(opts.path,"/oauth/client.json");
  assert.equal(opts.rejectUnauthorized,true);
  assert.equal(opts.headers.Authorization,undefined);
  assert.equal(opts.headers.Cookie,undefined);
  assert.equal(opts.method,"GET");
  opts.lookup("client.example.com",{},error=>assert.match(error.message,/SECOND_DNS_LOOKUP_DENIED/));
  assert.ok(opts.checkServerIdentity("8.8.8.8",{subject:{CN:"other.example.com"}}) instanceof Error);
  assert.throws(()=>pinnedRequestOptions(new URL(CLIENT),"127.0.0.1"));
});
test("IPv6 pinned transport works, alternate IPs are validated and no redirect is followed", async () => {
  const calls=[];
  assert.equal(await fetchPublicCimd(CLIENT,{resolve:async()=>[PUBLIC6],request:fakeRequest(calls)}),DOC);
  assert.equal(calls[0].hostname,PUBLIC6);
  assert.equal(calls[0].family,6);
  for (const options of [
    {status:302}, {body:"x".repeat(9000)}, {contentLength:9000},
    {contentType:"text/html"}, {encoding:"gzip"}, {peer:"127.0.0.1"},
    {peer:"1.1.1.1"},{authorized:false},
    {body:JSON.stringify({client_id:"https://other.example.com/client.json"})},
  ]) {
    const attempts=[];
    await assert.rejects(fetchPublicCimd(CLIENT,{resolve:async()=>[PUBLIC4],request:fakeRequest(attempts,options)}));
    assert.equal(attempts.length,1);
  }
});
test("relay authenticates before doing any outbound work and accepts only a CIMD ID", async () => {
  let reads=0;
  const handler=createHandler({secret:SECRET,load:async id=>{reads++;assert.equal(id,CLIENT);return DOC;}});
  const make=(body,auth="Bearer "+SECRET)=>new Request("https://relay.example.com/api/cimd",{
    method:"POST",headers:{"content-type":"application/json",authorization:auth},body:JSON.stringify(body)});
  assert.equal((await handler(make({client_id:CLIENT},"Bearer wrong"))).status,401);
  assert.equal((await createHandler({secret:""})(make({client_id:CLIENT}))).status,503);
  assert.equal((await handler(make({client_id:CLIENT,headers:{Authorization:"leak"}}))).status,400);
  assert.equal((await handler(make({client_id:"https://127.0.0.1/x"}))).status,400);
  assert.equal((await handler(make({client_id:"a".repeat(2000)}))).status,400);
  assert.equal(reads,0);
  const result=await handler(make({client_id:CLIENT}));
  assert.equal(result.status,200);
  assert.equal(await result.text(),DOC);
  assert.equal(result.headers.get("cache-control"),"no-store");
  assert.equal(reads,1);
});

// CIMD-only transport. No LifeSpace database, cookies, credentials or network bindings.
// IANA special-purpose registries (2025-10-09); reject even globally reachable
// protocol-specific ranges. IPv6 is restricted to ordinary global unicast.
import { BlockList, isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest, Agent } from "node:https";
import { checkServerIdentity } from "node:tls";

const MAX_ID = 256;
const MAX_DOCUMENT = 8192;
const MAX_ADDRESSES = 32;
const v4Blocked = new BlockList();
for (const [base, prefix] of [
  ["0.0.0.0",8], ["10.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8],
  ["169.254.0.0",16], ["172.16.0.0",12], ["192.0.0.0",24], ["192.0.2.0",24],
  ["192.31.196.0",24], ["192.52.193.0",24], ["192.88.99.0",24], ["192.168.0.0",16],
  ["192.175.48.0",24], ["198.18.0.0",15], ["198.51.100.0",24],
  ["203.0.113.0",24], ["224.0.0.0",4], ["240.0.0.0",4],
]) v4Blocked.addSubnet(base, prefix, "ipv4");
const v6Global = new BlockList();
v6Global.addSubnet("2000::", 3, "ipv6");
const v6Blocked = new BlockList();
for (const [base, prefix] of [
  ["2001::",23], ["2001:db8::",32], ["2002::",16],
  ["2620:4f:8000::",48], ["3fff::",20],
]) v6Blocked.addSubnet(base, prefix, "ipv6");

export function isOrdinaryPublicIp(address) {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  return family === 4 ? !v4Blocked.check(address, "ipv4")
    : family === 6 && v6Global.check(address, "ipv6") && !v6Blocked.check(address, "ipv6");
}

// Defense in depth: independently validate the same canonical URL grammar as
// Identity. No IP literal, userinfo, query, fragment, non-HTTPS port or root path.
export function parseClientUrl(value) {
  if (typeof value !== "string" || value.length > MAX_ID) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.href !== value || url.username || url.password
    || url.hash || url.search || url.port || url.pathname === "/" || url.hostname.endsWith(".")) return null;
  const host = url.hostname;
  const labels = host.split(".");
  if (host.length > 253 || !/^[a-z0-9.-]+$/u.test(host) || labels.length < 2
    || labels.some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))
    || !/^[a-z]{2,63}$/u.test(labels.at(-1) || "")
    || ["localhost","local","internal","test","invalid","example","onion"].includes(labels.at(-1))) return null;
  return url;
}

export async function resolvePublicAddresses(host, resolver = new Resolver({timeout: 1200, tries: 1})) {
  const timer = setTimeout(() => resolver.cancel(), 1800);
  const answer = async family => {
    try { return await (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host)); }
    catch (e) { if (e?.code === "ENODATA") return []; throw e; }
  };
  try {
    const [a, aaaa] = await Promise.all([answer(4), answer(6)]);
    const addresses = [...new Set([...a, ...aaaa])];
    // Reject the entire answer set if ANY address is private/special.
    // No resolution occurs between checking these addresses and connecting.
    if (!addresses.length || addresses.length > MAX_ADDRESSES
      || a.some(ip => isIP(ip) !== 4) || aaaa.some(ip => isIP(ip) !== 6)
      || !addresses.every(isOrdinaryPublicIp)) throw Error("DNS_TARGET_DENIED");
    return addresses;
  } finally {
    clearTimeout(timer);
    resolver.cancel();
  }
}

export function pinnedRequestOptions(url, address) {
  if (!isOrdinaryPublicIp(address)) throw Error("IP_TARGET_DENIED");
  return {
    hostname: address, family: isIP(address), port: 443,
    servername: url.hostname, method: "GET", path: url.pathname,
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => checkServerIdentity(url.hostname, cert),
    minVersion: "TLSv1.2",
    // Literal IP + explicit SNI and certificate identity, no second DNS lookup.
    lookup: (_hostname, _options, done) => done(Error("SECOND_DNS_LOOKUP_DENIED")),
    // A new private Agent, not a global agent or environment-configured proxy.
    agent: new Agent({keepAlive: false, proxyEnv: {}}),
    maxHeaderSize: 8192,
    headers: {Host: url.hostname, Accept: "application/json",
      "Accept-Encoding": "identity", "Cache-Control": "no-cache", Connection: "close"},
  };
}

function peerMatches(socket, address) {
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  const peer = socket?.remoteAddress;
  if (!isOrdinaryPublicIp(peer) || isIP(peer) !== isIP(address)) return false;
  const exact = new BlockList();
  exact.addAddress(address, family);
  return exact.check(peer, family);
}

function readPinnedDocument(url, address, deadline, request = httpsRequest) {
  const options = pinnedRequestOptions(url, address);
  return new Promise((resolve, reject) => {
    let req;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) req?.destroy();
      options.agent.destroy();
      if (error) reject(error); else resolve(value);
    };
    const remaining = Math.min(2600, deadline - Date.now());
    if (remaining <= 0) { finish(Error("DEADLINE")); return; }
    timer = setTimeout(() => finish(Error("DEADLINE")), remaining);
    try {
      req = request(options, res => {
        // No forwarding of upstream headers, status or error/body text.
        if (!peerMatches(res.socket, address) || res.statusCode !== 200
          || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(res.headers["content-type"] || "")
          || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
          || Number(res.headers["content-length"] || 0) > MAX_DOCUMENT) {
          res.destroy(); finish(Error("UPSTREAM_DENIED")); return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_DOCUMENT) { res.destroy(); finish(Error("DOCUMENT_TOO_LARGE")); return; }
          chunks.push(chunk);
        });
        res.on("aborted", () => finish(Error("UPSTREAM_ABORTED")));
        res.on("error", () => finish(Error("UPSTREAM_ERROR")));
        res.on("end", () => {
          if (settled) return;
          try {
            const raw = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks, size));
            const document = JSON.parse(raw);
            if (!document || Array.isArray(document) || typeof document !== "object"
              || document.client_id !== url.href) throw Error("INVALID_CLIENT_METADATA");
            finish(null, raw);
          } catch { finish(Error("INVALID_CLIENT_METADATA")); }
        });
      });
      req.on("socket", socket => {
        socket.once("secureConnect", () => {
          if (!peerMatches(socket, address) || !socket.authorized) finish(Error("TLS_PEER_DENIED"));
        });
      });
      req.on("error", () => finish(Error("UPSTREAM_ERROR")));
      req.end();
    } catch { finish(Error("UPSTREAM_ERROR")); }
  });
}

export async function fetchPublicCimd(clientId, deps = {}) {
  const url = parseClientUrl(clientId);
  if (!url) throw Error("INVALID_CLIENT_ID");
  const deadline = Date.now() + 5500;
  const addresses = await (deps.resolve || resolvePublicAddresses)(url.hostname);
  // Revalidate at the transport boundary even when a resolver is injected.
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > MAX_ADDRESSES
    || !addresses.every(isOrdinaryPublicIp)) throw Error("DNS_TARGET_DENIED");
  // Prefer IPv4 for hosts with both families, then try one validated alternate.
  // Never re-resolve the hostname, follow a redirect or use the global agent.
  const first = addresses.find(ip => isIP(ip) === 4) || addresses[0];
  const alternate = addresses.find(ip => isIP(ip) !== isIP(first)) || addresses.find(ip => ip !== first);
  for (const address of [first, alternate].filter(Boolean)) {
    try { return await readPinnedDocument(url, address, deadline, deps.request); }
    catch { if (Date.now() >= deadline) break; }
  }
  throw Error("METADATA_UNAVAILABLE");
}

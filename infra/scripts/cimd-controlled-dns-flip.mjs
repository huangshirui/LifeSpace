// One-name, owner-dispatched authoritative DNS flip acceptance.
// Cloudflare DNS record updates are confined to a cryptographically random
// cimd-rebind-<32 hex>.aisr.online A record and deleted on completion/error.
// This tests DNS changes BETWEEN requests, not within one TCP/TLS connection.
// No actual LifeSpace Identity/Account/Core app configuration is changed.
import assert from "node:assert/strict";
import { Resolver, lookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";

const ZONE = "aisr.online";
const NAME = /^cimd-rebind-[a-f0-9]{32}\.aisr\.online$/u;
const INITIAL_IP = "1.1.1.1";
const PRIVATE_IP = "10.255.255.254";
const TTL = 120;
const SLEEP_AFTER_FLIP_MS = 130000;

async function requestDnsApi(token, path, method = "GET", body) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    const code = data?.errors?.[0]?.code || "unknown";
    throw Error("Cloudflare DNS API " + method + " failed (HTTP " + response.status + ", code " + code + ")");
  }
  return data.result;
}

async function authoritativeAddresses(nameServers, hostname) {
  const records = [];
  for (const nameServer of nameServers) {
    const { address } = await lookup(nameServer, { family: 4 });
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([address]);
    const answers = await resolver.resolve4(hostname);
    records.push({ nameserver: nameServer, addresses: answers.sort() });
  }
  return records;
}

async function expectAuthoritative(nameServers, hostname, expected) {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const observed = await authoritativeAddresses(nameServers, hostname);
      if (observed.length >= 2 && observed.every(item => item.addresses.length === 1 && item.addresses[0] === expected)) {
        return observed;
      }
    } catch { /* the newly created record may not be visible on every NS immediately */ }
    await sleep(2000);
  }
  throw Error("Authoritative DNS did not converge to expected single A record (no claim about edge DNS caches)");
}

async function edgeProbe(previewUrl, authToken, expectedPhase) {
  const response = await fetch(previewUrl, {
    method: "POST", signal: AbortSignal.timeout(12000),
    headers: { authorization: "Bearer " + authToken, "x-cimd-dns-phase": expectedPhase },
  });
  assert.equal(response.status, 200, "Cloudflare remote preview DNS-probe invocation failed");
  const result = await response.json();
  assert.equal(result.name, expectedPhase);
  assert.ok(["http", "error", "timeout"].includes(result.outcome));
  return result;
}

export async function runControlledDnsFlip({ accountId, token, host, previewUrl, authToken, logger = console.log }) {
  assert.match(accountId || "", /^[a-f0-9]{32}$/u);
  assert.ok(typeof token === "string" && token.length > 8);
  assert.match(host || "", NAME);
  assert.ok(previewUrl === "http://127.0.0.1:8797/dns-flip", "Unexpected remote preview endpoint");
  assert.ok(typeof authToken === "string" && /^[a-f0-9]{64}$/u.test(authToken));

  const zones = await requestDnsApi(token, "/zones?name=" + encodeURIComponent(ZONE));
  assert.ok(Array.isArray(zones) && zones.length === 1 && zones[0].name === ZONE &&
    zones[0].account?.id === accountId && zones[0].status === "active",
    "DNS zone must be a single active aisr.online zone in the configured account");
  const zone = zones[0];
  assert.ok(Array.isArray(zone.name_servers) && zone.name_servers.length >= 2);
  const path = "/zones/" + encodeURIComponent(zone.id) + "/dns_records";
  const existing = await requestDnsApi(token, path + "?name.exact=" + encodeURIComponent(host) + "&per_page=20");
  assert.ok(Array.isArray(existing) && existing.length === 0, "Refusing to modify any pre-existing DNS record");

  let recordId = null;
  try {
    const created = await requestDnsApi(token, path, "POST", {
      type: "A", name: host, content: INITIAL_IP, ttl: TTL, proxied: false,
      comment: "LifeSpace ephemeral CIMD DNS flip acceptance; safe cleanup required",
    });
    recordId = created?.id;
    assert.match(recordId || "", /^[a-f0-9]{32}$/u);
    assert.equal(created.name, host);
    assert.equal(created.type, "A");
    assert.equal(created.content, INITIAL_IP);
    assert.equal(created.proxied, false);
    logger("DNS TEST: created isolated A record for " + host);
    const before = await expectAuthoritative(zone.name_servers.slice(0, 2), host, INITIAL_IP);
    logger("PASS: two authoritative DNS servers return public target " + INITIAL_IP);
    const first = await edgeProbe(previewUrl, authToken, "before-public");

    const updated = await requestDnsApi(token, path + "/" + encodeURIComponent(recordId), "PATCH", {
      content: PRIVATE_IP, ttl: TTL, proxied: false,
    });
    assert.equal(updated?.id, recordId);
    assert.equal(updated?.name, host);
    assert.equal(updated?.content, PRIVATE_IP);
    const after = await expectAuthoritative(zone.name_servers.slice(0, 2), host, PRIVATE_IP);
    logger("PASS: same authoritative hostname now returns private target " + PRIVATE_IP);
    // Cloudflare's authoritative DNS TTL is at least 120 seconds on normal
    // plans. This wait addresses previous-resolution caches *between*
    // requests. It cannot force a re-resolution inside a single connection.
    logger("DNS TEST: waiting " + (SLEEP_AFTER_FLIP_MS / 1000) + "s for cached answers to expire");
    await sleep(SLEEP_AFTER_FLIP_MS);
    const second = await edgeProbe(previewUrl, authToken, "after-private");
    assert.ok(!(second.outcome === "http" && second.status >= 200 && second.status < 300),
      "Private-target HTTPS fetch yielded HTTP 2xx; security regression");

    logger("PASS: same authoritative hostname changed public→private; subsequent edge fetch did not return 2xx");
    logger("DNS PHASES: " + JSON.stringify({ beforeAuthoritative: before, afterAuthoritative: after,
      first: { ...first, error: first.error?.slice(0, 100) },
      second: { ...second, error: second.error?.slice(0, 100) } }));
    logger("NOT PROVEN: which DNS answer remote edge used, or an in-flight same-connection DNS rebinding attempt");
    return { authoritativeFlipObserved: true, noPrivate2xxObserved: true,
      inFlightDnsRebindingProven: false, first, second };
  } finally {
    if (recordId) {
      // Fail closed before deletion: only delete the record whose returned
      // ID still points at our exact random host and type.
      const current = await requestDnsApi(token, path + "/" + encodeURIComponent(recordId));
      assert.ok(current?.id === recordId && current?.name === host && current?.type === "A" &&
        current?.proxied === false, "DNS record identity changed; refuse destructive cleanup");
      await requestDnsApi(token, path + "/" + encodeURIComponent(recordId), "DELETE");
      const leftover = await requestDnsApi(token, path + "?name.exact=" + encodeURIComponent(host));
      assert.ok(Array.isArray(leftover) && leftover.length === 0, "Ephemeral DNS record cleanup not verified");
      logger("PASS: temporary DNS A record deleted and its absence verified");
    }
  }
}

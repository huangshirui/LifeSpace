const targets = [
  "https://auth-staging.aisr.online/health",
  "https://core-staging.aisr.online/health",
];

for (const url of targets) {
  const response = await fetch(url, {
    redirect: "manual",
    headers: {
      "user-agent": "LifeSpace-GitHub-Actions/1.0",
      accept: "application/json,text/plain,*/*",
    },
  });

  const body = await response.text();
  const summary = body.replace(/\s+/g, " ").slice(0, 320);
  const diagnostic = {
    url,
    status: response.status,
    server: response.headers.get("server"),
    contentType: response.headers.get("content-type"),
    cfMitigated: response.headers.get("cf-mitigated"),
    cfRay: response.headers.get("cf-ray"),
    location: response.headers.get("location"),
    summary,
  };

  console.log(JSON.stringify(diagnostic, null, 2));

  if (response.status === 403) {
    if (diagnostic.cfMitigated === "challenge") {
      throw new Error(`${url} is being challenged by Cloudflare edge security (cf-mitigated=challenge)`);
    }
    throw new Error(`${url} is returning 403 from the Cloudflare edge; inspect Security > Events using cf-ray ${diagnostic.cfRay ?? "unknown"}`);
  }

  if (!response.ok) {
    throw new Error(`${url} returned unexpected status ${response.status}`);
  }
}

console.log("staging edge diagnostics passed");

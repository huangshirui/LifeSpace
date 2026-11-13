import { useEffect, useState } from "react";
import { consoleApi } from "./api";
import { SearchableSelect } from "./SearchableSelect";
import type { Application } from "./types";
import { matchesGrantChoice as matches, isActiveService, isActiveAgent } from "./grant-grantee-options";

export type GrantGranteeType = "user" | "space" | "service" | "device" | "agent";
type GrantRef = { granteeType: string; granteeId: string };
type Choice = { id: string; name: string; application?: string };
type AgentIdentity = { id: string; displayName: string; status: string; binding: { status: string } };
type Directory = Record<string, Choice>;

const keyOf = (type: string, id: string) => type + ":" + id;

async function agents(applicationId: string): Promise<AgentIdentity[]> {
  const response = await fetch(`/api/agent-governance/applications/${encodeURIComponent(applicationId)}/agents`, {
    credentials: "same-origin", headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string } } | null;
  if (!response.ok || !Array.isArray(payload?.data)) throw new Error(payload?.error?.message ?? "无法读取 Agent 目录");
  return payload.data as AgentIdentity[];
}

async function applicationChoices(app: Application, type: "service" | "agent", activeOnly: boolean): Promise<Choice[]> {
  if (type === "service") {
    const detail = await consoleApi.application(app.id);
    return detail.servicePrincipals
      .filter(row => !activeOnly || isActiveService(detail.application, row))
      .map(row => ({ id: row.id, name: row.displayName || row.id, application: app.name }));
  }
  return (await agents(app.id))
    .filter(row => !activeOnly || isActiveAgent(app, row))
    .map(row => ({ id: row.id, name: row.displayName || row.id, application: app.name }));
}

function useChoices(load: (() => Promise<Choice[]>) | null, scope: string, debounce = false) {
  const [state, setState] = useState<{ scope: string; rows: Choice[]; loading: boolean; error?: string }>({ scope: "", rows: [], loading: false });
  useEffect(() => {
    if (!load) return;
    let current = true;
    setState({ scope, rows: [], loading: true });
    const timer = window.setTimeout(() => {
      void load().then(rows => {
        if (current) setState({ scope, rows, loading: false });
      }).catch(error => {
        if (current) setState({ scope, rows: [], loading: false, error: error instanceof Error ? error.message : "读取失败" });
      });
    }, debounce ? 300 : 0);
    return () => { current = false; window.clearTimeout(timer); };
    // The scope is the complete identity of the request.
  }, [scope, debounce]);
  if (!load) return { rows: [], loading: false, error: undefined };
  return state.scope === scope ? state : { rows: [], loading: true, error: undefined };
}

export function GrantGranteePicker({ type, value, onChange, sourceSpaceId }: {
  type: GrantGranteeType; value: string; onChange: (id: string) => void; sourceSpaceId: string;
}) {
  const [apps, setApps] = useState<Application[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState("");
  const [appId, setAppId] = useState("");
  const [appQuery, setAppQuery] = useState("");
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [appsRetry, setAppsRetry] = useState(0);
  const machine = type === "service" || type === "agent";
  useEffect(() => {
    if (!machine) return;
    let current = true;
    setAppsLoading(true); setAppsError("");
    void consoleApi.applications().then(rows => {
      if (current) setApps(rows.filter(row => row.status === "active"));
    }).catch(error => {
      if (current) { setApps([]); setAppsError(error instanceof Error ? error.message : "无法读取应用"); }
    }).finally(() => { if (current) setAppsLoading(false); });
    return () => { current = false; };
  }, [machine, appsRetry]);

  const app = !appsLoading && !appsError ? apps.find(row => row.id === appId) : undefined;
  const directoryQuery = new URLSearchParams({ limit: "200", ...(query.trim() ? { q: query.trim() } : {}) });
  const load = machine && app ? () => applicationChoices(app, type as "service" | "agent", true)
    : type === "user" ? async () => (await consoleApi.users("?" + directoryQuery + "&status=active"))
      .filter(row => row.status === "active").map(row => ({ id: row.id, name: row.displayName || row.id }))
    : type === "space" ? async () => (await consoleApi.spaces("?" + directoryQuery))
      .map(row => ({ id: row.id, name: row.name || row.id }))
    : null;
  const scope = JSON.stringify([type, appId, machine ? "" : query, retry, sourceSpaceId]);
  const result = useChoices(load, scope, !machine);
  const rows = result.rows.filter(row => !machine || matches(row, query)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  if (type === "device") return <label className="cp-field"><span>Device ID</span><input value={value} onChange={event => onChange(event.target.value)} placeholder="Device ID" /><small>当前无设备目录，暂时手工填写。</small></label>;

  return <>
    {machine && <>
      <SearchableSelect label="所属应用 · Application" value={appId}
        options={apps.filter(row => matches({ id: row.id, name: row.name }, appQuery)).sort((a, b) => a.name.localeCompare(b.name))}
        query={appQuery} onQueryChange={setAppQuery} loading={appsLoading} disabled={!!appsError}
        onChange={id => { setAppId(id); setQuery(""); onChange(""); }} placeholder="搜索并选择应用" />
      {appsError && <div role="alert" className="cp-notice cp-error">{appsError}<button className="cp-secondary" onClick={() => { setAppId(""); setQuery(""); onChange(""); setAppsRetry(n => n + 1); }}>重试</button></div>}
      {!appsLoading && !appsError && !apps.length && <small>没有启用的 Application。</small>}
    </>}
    {(!machine || app) && <>
      <SearchableSelect key={appId || type} label={type === "agent" ? "Agent" : type === "service" ? "Service" : type === "user" ? "User" : "Space"}
        value={value} options={rows} query={query} onQueryChange={setQuery}
        loading={result.loading} disabled={!!result.error} onChange={onChange}
        placeholder="搜索并选择授权对象" />
      {!machine && <small>最多返回 200 条；未找到时请缩小搜索范围。</small>}
      {result.error && <div role="alert" className="cp-notice cp-error">{result.error}<button className="cp-secondary" onClick={() => { onChange(""); setRetry(n => n + 1); }}>重试</button></div>}
    </>}
  </>;
}

// Best-effort historical labels only. Missing/disabled/revoked directory entries never hide a Grant.
export function useGrantLabels(grants: readonly GrantRef[]): Directory {
  const signature = JSON.stringify([...new Set(grants.map(grant => keyOf(grant.granteeType, grant.granteeId)))].sort());
  const [state, setState] = useState<{ signature: string; labels: Directory }>({ signature: "", labels: {} });
  useEffect(() => {
    let current = true;
    const keys = JSON.parse(signature) as string[];
    const wanted = new Set(keys);
    const labels: Directory = {};
    const add = (type: string, row: Choice) => {
      const key = keyOf(type, row.id);
      if (!wanted.has(key)) return;
      const previous = labels[key];
      labels[key] = previous?.application && row.application && previous.application !== row.application
        ? { ...row, application: [...new Set([...previous.application.split(" / "), row.application])].sort().join(" / ") }
        : row;
    };
    const jobs: Array<() => Promise<void>> = [];
    for (const key of keys) {
      const split = key.indexOf(":");
      const type = key.slice(0, split), id = key.slice(split + 1);
      if (type === "user") jobs.push(async () => { const row = await consoleApi.user(id); add(type, { id, name: row.displayName || id }); });
      if (type === "space") jobs.push(async () => { const row = await consoleApi.space(id); add(type, { id, name: row.name || id }); });
    }
    async function resolve() {
      const types = (["service", "agent"] as const).filter(type => keys.some(key => key.startsWith(type + ":")));
      if (types.length) {
        try {
          const apps = await consoleApi.applications();
          for (const app of apps) for (const type of types) jobs.push(async () => {
            for (const row of await applicationChoices(app, type, false)) add(type, row);
          });
        } catch { /* preserve raw IDs on directory failure */ }
      }
      // Bound concurrency; do not fail Grant inspection when any directory lookup fails.
      for (let i = 0; current && i < jobs.length; i += 4) {
        await Promise.allSettled(jobs.slice(i, i + 4).map(job => job()));
        if (current) setState({ signature, labels: { ...labels } });
      }
    }
    void resolve();
    return () => { current = false; };
  }, [signature]);
  return state.signature === signature ? state.labels : {};
}

export function GrantGranteeLabel({ grant, labels }: { grant: GrantRef; labels: Directory }) {
  const choice = labels[keyOf(grant.granteeType, grant.granteeId)];
  return <><strong>{choice?.name ?? grant.granteeType}</strong><small>{choice ? [grant.granteeType, choice.application, grant.granteeId].filter(Boolean).join(" · ") : grant.granteeId}</small></>;
}

export function grantGranteeSummary(grant: GrantRef, labels: Directory): string {
  const choice = labels[keyOf(grant.granteeType, grant.granteeId)];
  return choice ? [choice.name, choice.application, grant.granteeId].filter(Boolean).join(" · ") : grant.granteeType + ":" + grant.granteeId;
}

import { useEffect, useMemo, useState, type ReactNode } from "react";

type GrantPermission = "free_busy" | "read" | "write" | "manage";
type GrantResourceType = "space" | "model";
type GrantGranteeType = "user" | "space" | "service" | "device" | "agent";

type DataGrant = {
  id: string;
  sourceSpaceId?: string;
  granteeType: GrantGranteeType;
  granteeId: string;
  resourceType: GrantResourceType;
  resourceId: string | null;
  permission: GrantPermission;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

type SpaceDetail = {
  id: string;
  name: string;
  grants: DataGrant[];
};

type PublishedModel = { key: string; state: string };
type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type DataEnvelope<T> = { data: T };

type Mode =
  | { type: "create" }
  | { type: "edit"; grant: DataGrant }
  | { type: "revoke"; grant: DataGrant }
  | null;

class GrantGovernanceError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "GrantGovernanceError";
  }
}

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new GrantGovernanceError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new GrantGovernanceError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
  return payload.data;
}

async function get<T>(path: string): Promise<T> {
  return readData<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));
}

async function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", intent: string, body: unknown): Promise<T> {
  return readData<T>(await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-lifespace-console-intent": intent,
    },
    body: JSON.stringify(body),
  }));
}

function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return pathname;
}

function spaceIdFromPath(pathname: string): string | null {
  const match = /^\/spaces\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return /^spc_[A-Za-z0-9_-]+$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function DialogShell({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cp-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="cp-dialog-header">
        <div><div className="cp-eyebrow">Platform governance</div><h2>{title}</h2><p>{description}</p></div>
        <button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      {children}
    </section>
  </div>;
}

function ErrorNotice({ error }: { error?: unknown }) {
  if (!error) return null;
  const value = error instanceof GrantGovernanceError ? error : new GrantGovernanceError(error instanceof Error ? error.message : "Unknown error");
  return <div className="cp-notice cp-error"><strong>{value.code ?? "操作失败"}</strong><span>{value.message}</span>{value.requestId && <small>requestId: {value.requestId}</small>}</div>;
}

function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toUtcInstant(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GrantGovernanceError("过期时间无效", "VALIDATION_ERROR");
  return date.toISOString();
}

function grantSummary(grant: DataGrant) {
  const resource = grant.resourceType === "space" ? "Whole Space" : grant.resourceId ?? "model";
  return `${grant.granteeType}:${grant.granteeId} → ${resource} · ${grant.permission}`;
}

function GrantGovernanceDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const [space, setSpace] = useState<SpaceDetail>();
  const [models, setModels] = useState<PublishedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [mode, setMode] = useState<Mode>(null);
  const [granteeType, setGranteeType] = useState<GrantGranteeType>("service");
  const [granteeId, setGranteeId] = useState("");
  const [resourceType, setResourceType] = useState<GrantResourceType>("space");
  const [resourceId, setResourceId] = useState("");
  const [permission, setPermission] = useState<GrantPermission>("read");
  const [expiresAt, setExpiresAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  async function load() {
    setLoading(true); setError(undefined);
    try {
      const [spaceData, modelRows] = await Promise.all([
        get<SpaceDetail>(`/api/spaces/${encodeURIComponent(spaceId)}`),
        get<PublishedModel[]>("/api/models"),
      ]);
      setSpace(spaceData);
      setModels(modelRows);
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [spaceId]);

  const activeGrants = useMemo(() => space?.grants.filter((grant) => !grant.revokedAt) ?? [], [space]);
  const revokedGrants = useMemo(() => space?.grants.filter((grant) => grant.revokedAt) ?? [], [space]);

  function resetCreate() {
    setMode({ type: "create" });
    setGranteeType("service");
    setGranteeId("");
    setResourceType("space");
    setResourceId("");
    setPermission("read");
    setExpiresAt("");
    setConfirmed(false);
    setError(undefined);
  }

  function startEdit(grant: DataGrant) {
    setMode({ type: "edit", grant });
    setPermission(grant.permission);
    setExpiresAt(toLocalInput(grant.expiresAt));
    setConfirmed(false);
    setError(undefined);
  }

  function startRevoke(grant: DataGrant) {
    setMode({ type: "revoke", grant });
    setConfirmed(false);
    setError(undefined);
  }

  async function createGrant() {
    if (mode?.type !== "create" || !confirmed || !granteeId.trim()) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<DataGrant>(`/api/spaces/${encodeURIComponent(spaceId)}/grants`, "POST", "create-space-data-grant", {
        granteeType,
        granteeId: granteeId.trim(),
        resourceType,
        resourceId: resourceType === "model" ? resourceId : null,
        permission,
        expiresAt: toUtcInstant(expiresAt),
        confirmSpaceId: spaceId,
      });
      setMode(null);
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function updateGrant() {
    if (mode?.type !== "edit" || !confirmed) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<DataGrant>(`/api/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(mode.grant.id)}`, "PATCH", "update-space-data-grant", {
        permission,
        expiresAt: toUtcInstant(expiresAt),
        confirmGrantId: mode.grant.id,
      });
      setMode(null);
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function revokeGrant() {
    if (mode?.type !== "revoke" || !confirmed) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<{ grantId: string; revoked: true }>(`/api/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(mode.grant.id)}`, "DELETE", "revoke-space-data-grant", {
        confirmGrantId: mode.grant.id,
      });
      setMode(null);
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  return <DialogShell title={`Data Grants · ${space?.name ?? spaceId}`} description="这里使用 Platform Admin Authority 治理同一份 Core Data Grant；不会让 Console、executor 或操作员自动获得 Space 业务数据访问权。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading ? <div className="cp-loading">正在读取 Space Grant 与 Model Registry…</div> : <>
        <div className="cp-app-summary"><strong>{space?.name ?? "Space"}</strong><code>{spaceId}</code></div>
        <div className="cp-row"><button className="cp-primary" onClick={resetCreate}>Add Grant</button><span>{activeGrants.length} active · {revokedGrants.length} revoked</span></div>
        <div className="cp-access-table">
          <div className="cp-access-head"><span>Grantee</span><span>Resource</span><span>Permission / expiry</span></div>
          {activeGrants.map((grant) => <div className="cp-access-row" key={grant.id}>
            <div><strong>{grant.granteeType}</strong><small>{grant.granteeId}</small></div>
            <div><strong>{grant.resourceType === "space" ? "Whole Space" : grant.resourceId}</strong><small>{grant.id}</small></div>
            <div><strong>{grant.permission}</strong><small>{grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : "Never expires"}</small><div className="cp-row"><button className="cp-secondary" onClick={() => startEdit(grant)}>Edit</button><button className="cp-danger" onClick={() => startRevoke(grant)}>Revoke</button></div></div>
          </div>)}
        </div>
        {!activeGrants.length && <div className="cp-loading">当前没有 active Data Grant。</div>}

        {mode?.type === "create" && <div className="cp-danger-box">
          <strong>Create Data Grant</strong>
          <label className="cp-field"><span>Grantee type</span><select value={granteeType} onChange={(event) => setGranteeType(event.target.value as GrantGranteeType)}><option value="service">Service</option><option value="agent">Agent</option><option value="user">User</option><option value="space">Space</option><option value="device">Device</option></select></label>
          <label className="cp-field"><span>Grantee ID</span><input value={granteeId} onChange={(event) => setGranteeId(event.target.value)} placeholder={granteeType === "service" ? "svc_*" : `${granteeType} id`} /></label>
          <label className="cp-field"><span>Resource</span><select value={resourceType} onChange={(event) => { const next = event.target.value as GrantResourceType; setResourceType(next); if (next === "model" && permission === "free_busy") setPermission("read"); }}><option value="space">Whole Space</option><option value="model">Specific Model</option></select></label>
          {resourceType === "model" && <label className="cp-field"><span>Model</span><select value={resourceId} onChange={(event) => setResourceId(event.target.value)}><option value="">Select model…</option>{models.map((model) => <option key={model.key} value={model.key}>{model.key}</option>)}</select></label>}
          <label className="cp-field"><span>Permission</span><select value={permission} onChange={(event) => setPermission(event.target.value as GrantPermission)}>{resourceType === "space" && <option value="free_busy">free_busy</option>}<option value="read">read</option><option value="write">write</option><option value="manage">manage</option></select></label>
          <label className="cp-field"><span>Expires (optional)</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
          <label className="cp-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认由 Platform Admin 为 {spaceId} 创建此 Data Grant，并理解它会立即影响后续 Runtime Authority。</span></label>
          <button className="cp-primary" disabled={busy || !confirmed || !granteeId.trim() || (resourceType === "model" && !resourceId)} onClick={() => void createGrant()}>{busy ? "创建中…" : "Create Grant"}</button>
        </div>}

        {mode?.type === "edit" && <div className="cp-danger-box">
          <strong>Edit {mode.grant.id}</strong><span>{grantSummary(mode.grant)}</span>
          <label className="cp-field"><span>Permission</span><select value={permission} onChange={(event) => setPermission(event.target.value as GrantPermission)}>{mode.grant.resourceType === "space" && <option value="free_busy">free_busy</option>}<option value="read">read</option><option value="write">write</option><option value="manage">manage</option></select></label>
          <label className="cp-field"><span>Expires (empty = never)</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
          <label className="cp-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认修改此 Grant 的权限/有效期。</span></label>
          <button className="cp-primary" disabled={busy || !confirmed} onClick={() => void updateGrant()}>{busy ? "保存中…" : "Save Grant"}</button>
        </div>}

        {mode?.type === "revoke" && <div className="cp-danger-box">
          <strong>Revoke {mode.grant.id}</strong><span>{grantSummary(mode.grant)}</span>
          <label className="cp-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认撤销此 Data Grant；后续 Authority 检查将不再使用它。</span></label>
          <button className="cp-danger" disabled={busy || !confirmed} onClick={() => void revokeGrant()}>{busy ? "撤销中…" : "Revoke Grant"}</button>
        </div>}
        <ErrorNotice error={error} />
      </>}
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>
  </DialogShell>;
}

export default function SpaceGrantGovernanceOverlay() {
  const pathname = usePathname();
  const spaceId = spaceIdFromPath(pathname);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [spaceId]);
  if (!spaceId) return null;
  return <>
    <div className="cp-launcher" aria-label="Space Data Grant governance">
      <span className="cp-launcher-label">Configure</span>
      <button onClick={() => setOpen(true)}>Data grants</button>
    </div>
    {open && <GrantGovernanceDialog spaceId={spaceId} onClose={() => setOpen(false)} />}
  </>;
}

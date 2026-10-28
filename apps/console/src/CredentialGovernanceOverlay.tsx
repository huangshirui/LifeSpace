import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApplicationDetail, ApplicationCredential, ServicePrincipal } from "./types";
import AgentIdentitiesDialog from "./AgentIdentitiesDialog";
import "./credential-governance.css";

type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type DataEnvelope<T> = { data: T };
type Dialog = { type: "credentials" | "services" | "agents"; applicationId: string } | null;

type ServiceToken = {
  id: string;
  principalId: string;
  displayPrefix: string;
  lastFour: string;
  label: string;
  scopes: string[];
  audience: string;
  expiresAt: string | null;
  createdAt: string;
  createdByUserId: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type RevealResult<T> = { [key: string]: T | string } & { revealPath: string };

class CredentialGovernanceError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "CredentialGovernanceError";
  }
}

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new CredentialGovernanceError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new CredentialGovernanceError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
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

function applicationIdFromPath(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "applications" || !parts[1]) return undefined;
  try { return decodeURIComponent(parts[1]); }
  catch { return undefined; }
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))];
}

function scopeText(scopes: string[]): string { return scopes.join("\n"); }

function toInputDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function DialogShell({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cp-dialog cgp-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="cp-dialog-header">
        <div><div className="cp-eyebrow">Credential governance</div><h2>{title}</h2><p>{description}</p></div>
        <button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      {children}
    </section>
  </div>;
}

function ErrorNotice({ error }: { error?: unknown }) {
  if (!error) return null;
  const value = error instanceof CredentialGovernanceError
    ? error
    : new CredentialGovernanceError(error instanceof Error ? error.message : "Unknown error");
  return <div className="cp-notice cp-error"><strong>{value.code ?? "操作失败"}</strong><span>{value.message}</span>{value.requestId && <small>requestId: {value.requestId}</small>}</div>;
}

function RevealNotice({ revealPath, onConsumed }: { revealPath?: string; onConsumed: () => void }) {
  if (!revealPath) return null;
  return <div className="cgp-reveal-notice">
    <div><strong>一次性密钥已生成</strong><span>密钥没有进入 React/JavaScript。请在 60 秒内打开无脚本 reveal 页面并立即保存到目标系统。</span></div>
    <a href={revealPath} target="_blank" rel="noreferrer" onClick={onConsumed}>Open one-time secret</a>
  </div>;
}

function CredentialsDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ApplicationDetail>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [revealPath, setRevealPath] = useState<string>();

  async function load() {
    setLoading(true); setError(undefined);
    try { setDetail(await get<ApplicationDetail>(`/api/applications/${encodeURIComponent(applicationId)}`)); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [applicationId]);

  async function createCredential() {
    if (!detail?.application.trustedBackend) return;
    setBusy(true); setError(undefined); setRevealPath(undefined);
    try {
      const result = await mutate<{ credential: ApplicationCredential; revealPath: string }>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/credentials`, "POST", "create-application-credential", { confirmApplicationId: applicationId });
      setRevealPath(result.revealPath);
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function revokeCredential(item: ApplicationCredential) {
    if (!window.confirm(`确认撤销 Application credential ${item.id}（suffix ${item.secretSuffix}）？使用它的后端会立即无法通过 Identity 认证。`)) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<{ revoked: true }>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(item.id)}`, "DELETE", "revoke-application-credential", {
        confirmApplicationId: applicationId,
        confirmCredentialId: item.id,
      });
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  const active = detail?.credentials.filter((item) => item.status === "active" && !item.revokedAt) ?? [];
  const history = detail?.credentials.filter((item) => item.status !== "active" || item.revokedAt) ?? [];

  return <DialogShell title="Application credentials" description="管理 trusted-backend Application 的 lsa_* 凭证。浏览器 JavaScript 只看到凭证元数据；新明文通过短 TTL、AES-GCM sealed 的无脚本 reveal handoff 交付。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading && !detail ? <div className="cp-loading">正在读取 Application credential metadata…</div> : detail && <>
        <div className="cgp-summary"><strong>{detail.application.name}</strong><code>{applicationId}</code><span>{detail.application.trustedBackend ? "trusted backend" : "untrusted client"}</span></div>
        {!detail.application.trustedBackend && <div className="cgp-warning"><strong>此 Application 不允许长期后端凭证</strong><span>trustedBackend 是创建时不可变分类；Identity 会拒绝为普通客户端创建 lsa_*。</span></div>}
        <RevealNotice revealPath={revealPath} onConsumed={() => setRevealPath(undefined)} />
        <div className="cgp-section-title"><div><strong>Active credentials</strong><span>{active.length}</span></div>{detail.application.trustedBackend && <button className="cp-primary" disabled={busy || detail.application.status !== "active"} onClick={() => void createCredential()}>Create replacement</button>}</div>
        <div className="cgp-list">{active.length ? active.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.id}</strong><small>••••••••{item.secretSuffix} · created {new Date(item.createdAt).toLocaleString()}</small></div><button className="cgp-danger" disabled={busy} onClick={() => void revokeCredential(item)}>Revoke</button></div>) : <div className="cp-loading">当前没有 active credential。</div>}</div>
        {!!history.length && <><div className="cgp-section-title"><div><strong>Revoked history</strong><span>{history.length}</span></div></div><div className="cgp-list cgp-muted">{history.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.id}</strong><small>suffix {item.secretSuffix} · revoked {item.revokedAt ? new Date(item.revokedAt).toLocaleString() : item.status}</small></div></div>)}</div></>}
      </>}
      <ErrorNotice error={error} />
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>
  </DialogShell>;
}

function PrincipalEditor({ applicationId, applicationScopes, principal, onSaved, onCancel }: { applicationId: string; applicationScopes: string[]; principal?: ServicePrincipal; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [displayName, setDisplayName] = useState(principal?.displayName ?? "");
  const [description, setDescription] = useState(principal?.description ?? "");
  const [scopes, setScopes] = useState(scopeText(principal?.maxScopes ?? applicationScopes));
  const [status, setStatus] = useState<"active" | "disabled">(principal?.status === "disabled" ? "disabled" : "active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function save() {
    setBusy(true); setError(undefined);
    try {
      if (principal) {
        await mutate<ServicePrincipal>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principal.id)}`, "PATCH", "update-service-principal", {
          displayName: displayName.trim(),
          description: description.trim() || null,
          maxScopes: parseScopes(scopes),
          status,
          confirmApplicationId: applicationId,
          confirmPrincipalId: principal.id,
        });
      } else {
        await mutate<ServicePrincipal>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/service-principals`, "POST", "create-service-principal", {
          displayName: displayName.trim(),
          description: description.trim() || null,
          maxScopes: parseScopes(scopes),
          confirmApplicationId: applicationId,
        });
      }
      await onSaved();
    } catch (cause) { setError(cause); setBusy(false); }
  }

  return <div className="cgp-editor">
    <div className="cgp-form-grid"><label className="cp-field"><span>Display name</span><input value={displayName} maxLength={100} onChange={(event) => setDisplayName(event.target.value)} /></label>{principal && <label className="cp-field cgp-compact"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}><option value="active">active</option><option value="disabled">disabled</option></select></label>}</div>
    <label className="cp-field"><span>Description</span><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
    <label className="cp-field"><span>Max scopes</span><textarea className="cgp-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} spellCheck={false} /><small>必须保持在 Application allowedScopes 上限内；Identity 仍做最终校验。</small></label>
    {principal && status === "disabled" && principal.status !== "disabled" && <div className="cp-danger-box"><strong>Disable principal</strong><span>该主体签发的新认证和当前 token 使用将按 Identity 策略被拒绝；历史和 token metadata 不会被删除。</span></div>}
    <ErrorNotice error={error} />
    <div className="cgp-actions"><button className="cp-secondary" disabled={busy} onClick={onCancel}>取消</button><button className="cp-primary" disabled={busy || !displayName.trim()} onClick={() => void save()}>{busy ? "保存中…" : principal ? "Save principal" : "Create principal"}</button></div>
  </div>;
}

function TokenManager({ applicationId, principal, onClose }: { applicationId: string; principal: ServicePrincipal; onClose: () => void }) {
  const [tokens, setTokens] = useState<ServiceToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [revealPath, setRevealPath] = useState<string>();
  const [editing, setEditing] = useState<ServiceToken>();
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState(scopeText(principal.maxScopes));
  const [expiresAt, setExpiresAt] = useState("");

  async function load() {
    setLoading(true); setError(undefined);
    try { setTokens(await get<ServiceToken[]>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principal.id)}/tokens`)); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [applicationId, principal.id]);

  function resetForm() {
    setEditing(undefined); setLabel(""); setScopes(scopeText(principal.maxScopes)); setExpiresAt("");
  }

  function editToken(item: ServiceToken) {
    setEditing(item); setLabel(item.label); setScopes(scopeText(item.scopes)); setExpiresAt(toInputDateTime(item.expiresAt)); setRevealPath(undefined);
  }

  async function saveToken() {
    setBusy(true); setError(undefined); setRevealPath(undefined);
    try {
      if (editing) {
        await mutate<ServiceToken>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principal.id)}/tokens/${encodeURIComponent(editing.id)}`, "PATCH", "update-service-token", {
          label: label.trim(),
          scopes: parseScopes(scopes),
          expiresAt: toIsoDateTime(expiresAt),
          confirmApplicationId: applicationId,
          confirmPrincipalId: principal.id,
          confirmTokenId: editing.id,
        });
      } else {
        const result = await mutate<{ token: ServiceToken; revealPath: string }>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principal.id)}/tokens`, "POST", "create-service-token", {
          label: label.trim(),
          scopes: parseScopes(scopes),
          expiresAt: toIsoDateTime(expiresAt),
          confirmApplicationId: applicationId,
          confirmPrincipalId: principal.id,
        });
        setRevealPath(result.revealPath);
      }
      resetForm();
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function revokeToken(item: ServiceToken) {
    if (!window.confirm(`确认撤销 Service API Token ${item.label} (${item.id})？外部系统使用该 token 的后续请求将失败。`)) return;
    setBusy(true); setError(undefined); setRevealPath(undefined);
    try {
      await mutate<{ revoked: true }>(`/api/credential-governance/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principal.id)}/tokens/${encodeURIComponent(item.id)}`, "DELETE", "revoke-service-token", {
        confirmApplicationId: applicationId,
        confirmPrincipalId: principal.id,
        confirmTokenId: item.id,
      });
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  const active = tokens.filter((item) => !item.revokedAt);
  const revoked = tokens.filter((item) => item.revokedAt);

  return <div className="cgp-token-manager">
    <div className="cgp-subhead"><div><strong>Service API Tokens</strong><span>{principal.displayName} · {principal.id}</span></div><button className="cp-secondary" onClick={onClose}>返回 principals</button></div>
    <RevealNotice revealPath={revealPath} onConsumed={() => setRevealPath(undefined)} />
    <div className="cgp-editor">
      <div className="cgp-form-grid"><label className="cp-field"><span>{editing ? "Token label" : "New token label"}</span><input value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} /></label><label className="cp-field"><span>Expires at</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label></div>
      <label className="cp-field"><span>Scopes</span><textarea className="cgp-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} spellCheck={false} /><small>{editing ? "现有 token 的 scopes 只能缩小，不能扩大；Identity 强制执行。" : "必须同时落在 Application allowedScopes 与 principal maxScopes 内。"}</small></label>
      <div className="cgp-actions">{editing && <button className="cp-secondary" disabled={busy} onClick={resetForm}>取消编辑</button>}<button className="cp-primary" disabled={busy || !label.trim() || principal.status !== "active"} onClick={() => void saveToken()}>{busy ? "保存中…" : editing ? "Update token" : "Create token"}</button></div>
    </div>
    <ErrorNotice error={error} />
    <div className="cgp-section-title"><div><strong>Active tokens</strong><span>{active.length}</span></div></div>
    <div className="cgp-list">{loading ? <div className="cp-loading">正在读取 token metadata…</div> : active.length ? active.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.label}</strong><small>{item.displayPrefix}••••{item.lastFour} · {item.scopes.join(", ") || "no scopes"}{item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleString()}` : " · no expiry"}</small></div><div className="cgp-row-actions"><button disabled={busy} onClick={() => editToken(item)}>Edit</button><button className="cgp-danger" disabled={busy} onClick={() => void revokeToken(item)}>Revoke</button></div></div>) : <div className="cp-loading">当前没有 active token。</div>}</div>
    {!!revoked.length && <><div className="cgp-section-title"><div><strong>Revoked token history</strong><span>{revoked.length}</span></div></div><div className="cgp-list cgp-muted">{revoked.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.label}</strong><small>{item.id} · revoked {item.revokedAt ? new Date(item.revokedAt).toLocaleString() : ""}</small></div></div>)}</div></>}
  </div>;
}

function ServiceIdentitiesDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ApplicationDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [editor, setEditor] = useState<"new" | ServicePrincipal>();
  const [tokenPrincipal, setTokenPrincipal] = useState<ServicePrincipal>();

  async function load() {
    setLoading(true); setError(undefined);
    try { setDetail(await get<ApplicationDetail>(`/api/applications/${encodeURIComponent(applicationId)}`)); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [applicationId]);

  const applicationScopes = detail?.application.allowedScopes ?? [];
  const principals = useMemo(() => detail?.servicePrincipals ?? [], [detail]);

  if (tokenPrincipal) return <DialogShell title="Service identity tokens" description="Service API Token 是外部系统的 bearer credential；token scopes 仍会与 Application × Model Access、Space/Data Grant 和模型能力求交集。" onClose={onClose}><div className="cp-dialog-body"><TokenManager applicationId={applicationId} principal={tokenPrincipal} onClose={() => setTokenPrincipal(undefined)} /></div></DialogShell>;

  return <DialogShell title="Service Principals" description="管理外部系统/自动化主体。Service Principal 不是 Space member；真正的数据权限仍来自独立的 Space/Data Grant 配置。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading && !detail ? <div className="cp-loading">正在读取 service identities…</div> : detail && <>
        <div className="cgp-summary"><strong>{detail.application.name}</strong><code>{applicationId}</code><span>{detail.application.allowedScopes.length} allowed scopes</span></div>
        <div className="cgp-authority"><strong>Effective authority</strong><code>token scopes ∩ principal maxScopes ∩ Application allowedScopes ∩ Application × Model Access ∩ Space/Data Grant ∩ model policy</code></div>
        {editor && <PrincipalEditor applicationId={applicationId} applicationScopes={applicationScopes} principal={editor === "new" ? undefined : editor} onCancel={() => setEditor(undefined)} onSaved={async () => { setEditor(undefined); await load(); }} />}
        {!editor && <div className="cgp-section-title"><div><strong>Principals</strong><span>{principals.length}</span></div><button className="cp-primary" disabled={detail.application.status !== "active"} onClick={() => setEditor("new")}>New principal</button></div>}
        {!editor && <div className="cgp-list">{principals.length ? principals.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.displayName}</strong><small>{item.id} · {item.status} · {item.maxScopes.join(", ") || "no scopes"}</small>{item.description && <small>{item.description}</small>}</div><div className="cgp-row-actions"><button onClick={() => setEditor(item)}>Edit</button><button onClick={() => setTokenPrincipal(item)}>Tokens</button></div></div>) : <div className="cp-loading">当前没有 Service Principal。</div>}</div>}
      </>}
      <ErrorNotice error={error} />
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>
  </DialogShell>;
}

export default function CredentialGovernanceOverlay() {
  const applicationId = applicationIdFromPath(usePathname());
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!applicationId) return null;

  return <>
    <div className="cgp-launcher" aria-label="Credential governance">
      <span className="cp-launcher-label">Access</span>
      <button onClick={() => setDialog({ type: "credentials", applicationId })}>Credentials</button>
      <button onClick={() => setDialog({ type: "services", applicationId })}>Service identities</button>
      <button onClick={() => setDialog({ type: "agents", applicationId })}>Agent identities</button>
    </div>
    {dialog?.type === "credentials" && <CredentialsDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
    {dialog?.type === "services" && <ServiceIdentitiesDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
    {dialog?.type === "agents" && <AgentIdentitiesDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
  </>;
}

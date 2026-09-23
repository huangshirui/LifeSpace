import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccessAudience, Application, ApplicationDetail } from "./types";
import AgentIdentitiesDialog from "./AgentIdentitiesDialog";
import "./application-configuration.css";

type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type DataEnvelope<T> = { data: T };
type Dialog =
  | { type: "create" }
  | { type: "settings"; applicationId: string }
  | { type: "audiences"; applicationId: string }
  | { type: "agents"; applicationId: string }
  | null;

type CreateApplicationResult = {
  application: Application;
  initialCredentialRevoked: boolean;
};

class ApplicationConfigurationError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "ApplicationConfigurationError";
  }
}

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new ApplicationConfigurationError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new ApplicationConfigurationError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
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

function decodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return decodeURIComponent(value); }
  catch { return undefined; }
}

function applicationContext(pathname: string): { page: "applications" | "application" | "other"; applicationId?: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "applications" && !parts[1]) return { page: "applications" };
  if (parts[0] === "applications" && parts[1]) return { page: "application", applicationId: decodePathSegment(parts[1]) };
  return { page: "other" };
}

function parseScopes(value: string): string[] {
  const scopes = value.split(/[\s,]+/u).map((scope) => scope.trim()).filter(Boolean);
  return [...new Set(scopes)];
}

function scopeText(scopes: string[]): string {
  return scopes.join("\n");
}

function DialogShell({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cp-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="cp-dialog-header">
        <div><div className="cp-eyebrow">Application control plane</div><h2>{title}</h2><p>{description}</p></div>
        <button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      {children}
    </section>
  </div>;
}

function ErrorNotice({ error }: { error?: unknown }) {
  if (!error) return null;
  const value = error instanceof ApplicationConfigurationError
    ? error
    : new ApplicationConfigurationError(error instanceof Error ? error.message : "Unknown error");
  return <div className="cp-notice cp-error"><strong>{value.code ?? "操作失败"}</strong><span>{value.message}</span>{value.requestId && <small>requestId: {value.requestId}</small>}</div>;
}

function ApplicationSummary({ application }: { application: Application }) {
  return <div className="acp-summary">
    <div><span>Application ID</span><code>{application.id}</code></div>
    <div><span>Client type</span><strong>{application.clientType}</strong></div>
    <div><span>Trusted backend</span><strong>{application.trustedBackend ? "Yes" : "No"}</strong></div>
    <div><span>Status</span><strong>{application.status}</strong></div>
  </div>;
}

function CreateApplicationDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState<Application["clientType"]>("web");
  const [trustedBackend, setTrustedBackend] = useState(false);
  const [ttl, setTtl] = useState(900);
  const [scopes, setScopes] = useState("profile:read\nresources:read");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function create() {
    if (!name.trim() || confirmName !== name.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const result = await mutate<CreateApplicationResult>("/api/application-config/applications", "POST", "create-platform-application", {
        name: name.trim(),
        clientType,
        allowedScopes: parseScopes(scopes),
        trustedBackend,
        accessTokenTtlSeconds: ttl,
        confirmName: confirmName.trim(),
      });
      window.location.assign(`/applications/${encodeURIComponent(result.application.id)}`);
    } catch (cause) {
      setError(cause); setBusy(false);
    }
  }

  return <DialogShell title="Create Application" description="创建一个 Identity 权威 Application。Application ID 由 Identity 生成；Model Access、Service Principal 与 Space/Data Grant 不会被隐式创建。" onClose={onClose}>
    <div className="cp-dialog-body">
      <div className="acp-form-grid">
        <label className="cp-field"><span>Name</span><input value={name} maxLength={100} onChange={(event) => { setName(event.target.value); setConfirmName(""); }} placeholder="例如 Customer Portal" /></label>
        <label className="cp-field cp-compact"><span>Client type</span><select value={clientType} onChange={(event) => setClientType(event.target.value as Application["clientType"])}><option value="web">web</option><option value="mini_program">mini_program</option><option value="service">service</option><option value="device">device</option></select></label>
        <label className="cp-field cp-compact"><span>Access token TTL (seconds)</span><input type="number" min={300} max={3600} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></label>
        <label className="acp-toggle"><input type="checkbox" checked={trustedBackend} onChange={(event) => setTrustedBackend(event.target.checked)} /><span><strong>Trusted backend</strong><small>这是创建时的不可变分类。</small></span></label>
      </div>
      <label className="cp-field"><span>Allowed scopes</span><textarea className="acp-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} spellCheck={false} /><small>空格、逗号或换行分隔。Identity 仍是最终 scope 校验与签发权威。</small></label>
      {trustedBackend && <div className="acp-warning"><strong>当前 Slice B 不向浏览器返回 lsa_* 明文</strong><span>Identity 在 trusted-backend 创建时产生的初始一次性 credential 会由 Console BFF 立即撤销，因此不会形成浏览器可见的长期后端密钥。后端凭证生命周期将在独立 Credential slice 中按安全边界补齐。</span></div>}
      <label className="cp-field"><span>确认创建</span><input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={`输入 ${name.trim() || "Application name"}`} /></label>
      <ErrorNotice error={error} />
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>取消</button><button className="cp-primary" disabled={busy || !name.trim() || confirmName !== name.trim() || ttl < 300 || ttl > 3600} onClick={() => void create()}>{busy ? "创建中…" : "Create application"}</button></footer>
  </DialogShell>;
}

function ApplicationSettingsDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ApplicationDetail>();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [ttl, setTtl] = useState(900);
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    void get<ApplicationDetail>(`/api/applications/${encodeURIComponent(applicationId)}`).then((value) => {
      if (!active) return;
      setDetail(value);
      setName(value.application.name);
      setScopes(scopeText(value.application.allowedScopes));
      setTtl(value.application.accessTokenTtlSeconds);
      setStatus(value.application.status === "disabled" ? "disabled" : "active");
      setLoading(false);
    }, (cause) => { if (active) { setError(cause); setLoading(false); } });
    return () => { active = false; };
  }, [applicationId]);

  const changed = useMemo(() => {
    if (!detail) return false;
    const current = detail.application;
    return name.trim() !== current.name
      || JSON.stringify(parseScopes(scopes)) !== JSON.stringify(current.allowedScopes)
      || ttl !== current.accessTokenTtlSeconds
      || status !== current.status;
  }, [detail, name, scopes, ttl, status]);

  async function save() {
    if (!detail || !changed || !confirmed) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<Application>(`/api/application-config/applications/${encodeURIComponent(applicationId)}`, "PATCH", "update-platform-application", {
        name: name.trim(),
        allowedScopes: parseScopes(scopes),
        accessTokenTtlSeconds: ttl,
        status,
        confirmApplicationId: applicationId,
      });
      window.location.reload();
    } catch (cause) { setError(cause); setBusy(false); }
  }

  return <DialogShell title="Application settings" description="只修改 Identity 合同允许变更的字段：name、allowedScopes、token TTL、status。clientType 与 trustedBackend 不可变。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading ? <div className="cp-loading">正在读取 Application…</div> : detail && <>
        <ApplicationSummary application={detail.application} />
        <div className="acp-form-grid">
          <label className="cp-field"><span>Name</span><input value={name} maxLength={100} onChange={(event) => { setName(event.target.value); setConfirmed(false); }} /></label>
          <label className="cp-field cp-compact"><span>Access token TTL</span><input type="number" min={300} max={3600} value={ttl} onChange={(event) => { setTtl(Number(event.target.value)); setConfirmed(false); }} /></label>
          <label className="cp-field cp-compact"><span>Status</span><select value={status} onChange={(event) => { setStatus(event.target.value as "active" | "disabled"); setConfirmed(false); }}><option value="active">active</option><option value="disabled">disabled</option></select></label>
        </div>
        <label className="cp-field"><span>Allowed scopes</span><textarea className="acp-scopes" value={scopes} onChange={(event) => { setScopes(event.target.value); setConfirmed(false); }} spellCheck={false} /></label>
        {status === "disabled" && detail.application.status !== "disabled" && <div className="cp-danger-box"><strong>Disabling is immediately authoritative</strong><span>Identity 会拒绝该 Application 的后续认证/签发路径；它不会自动删除 Model Access、Service Principals 或审计历史。</span></div>}
        <label className="cp-confirm"><input type="checkbox" checked={confirmed} disabled={!changed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认将这些 Application policy 变更应用到 {applicationId}。</span></label>
      </>}
      <ErrorNotice error={error} />
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>取消</button><button className="cp-primary" disabled={busy || loading || !changed || !confirmed || !name.trim() || ttl < 300 || ttl > 3600} onClick={() => void save()}>{busy ? "保存中…" : "Save application"}</button></footer>
  </DialogShell>;
}

function AccessAudiencesDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ApplicationDetail>();
  const [audience, setAudience] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function load() {
    setLoading(true); setError(undefined);
    try {
      const value = await get<ApplicationDetail>(`/api/applications/${encodeURIComponent(applicationId)}`);
      setDetail(value);
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [applicationId]);

  async function register() {
    if (!audience.trim()) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<AccessAudience>(`/api/application-config/applications/${encodeURIComponent(applicationId)}/access-audiences`, "POST", "register-access-audience", {
        audience: audience.trim(),
        confirmApplicationId: applicationId,
      });
      setAudience("");
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function revoke(item: AccessAudience) {
    const accepted = window.confirm(`确认撤销 Cloudflare Access audience ${item.audience}？撤销后使用该 aud 的新身份交换会被拒绝。`);
    if (!accepted) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<{ revoked: true }>(`/api/application-config/applications/${encodeURIComponent(applicationId)}/access-audiences/${encodeURIComponent(item.id)}`, "DELETE", "revoke-access-audience", {
        confirmApplicationId: applicationId,
        confirmAudienceId: item.id,
      });
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  const activeAudiences = detail?.accessAudiences.filter((item) => item.status === "active" && !item.revokedAt) ?? [];
  const historicalAudiences = detail?.accessAudiences.filter((item) => item.status !== "active" || item.revokedAt) ?? [];

  return <DialogShell title="Cloudflare Access audiences" description="Access aud 只绑定 Web 登录的 Application context，不识别用户本人；(iss, sub) -> usr_* 仍由 Identity 独立解析。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading && !detail ? <div className="cp-loading">正在读取 Access audiences…</div> : detail && <>
        <ApplicationSummary application={detail.application} />
        {detail.application.clientType !== "web" || !detail.application.trustedBackend
          ? <div className="acp-warning"><strong>此 Application 不符合 Access audience 注册条件</strong><span>Identity 只允许 active trusted Web Application 注册 Cloudflare Access audience。</span></div>
          : <div className="acp-inline-form"><label className="cp-field"><span>New audience (AUD)</span><input value={audience} maxLength={256} onChange={(event) => setAudience(event.target.value)} placeholder="Cloudflare Access Application AUD" /></label><button className="cp-primary" disabled={busy || !audience.trim()} onClick={() => void register()}>Register</button></div>}
        <div className="acp-section"><div className="acp-section-title"><strong>Active</strong><span>{activeAudiences.length}</span></div>{activeAudiences.length ? activeAudiences.map((item) => <div className="acp-audience" key={item.id}><div><code>{item.audience}</code><small>{item.issuer}</small></div><button disabled={busy} onClick={() => void revoke(item)}>Revoke</button></div>) : <div className="cp-loading">当前没有 active audience。</div>}</div>
        {!!historicalAudiences.length && <div className="acp-section"><div className="acp-section-title"><strong>Revoked history</strong><span>{historicalAudiences.length}</span></div>{historicalAudiences.map((item) => <div className="acp-audience acp-muted" key={item.id}><div><code>{item.audience}</code><small>{item.revokedAt ?? item.status}</small></div></div>)}</div>}
      </>}
      <ErrorNotice error={error} />
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>
  </DialogShell>;
}

export default function ApplicationConfigurationOverlay() {
  const context = applicationContext(usePathname());
  const [dialog, setDialog] = useState<Dialog>(null);
  if (context.page === "other") return null;

  return <>
    <div className={`acp-launcher ${context.page === "application" ? "acp-launcher-stacked" : ""}`} aria-label="Application configuration">
      <span className="cp-launcher-label">Application</span>
      {context.page === "applications" && <button onClick={() => setDialog({ type: "create" })}>New application</button>}
      {context.page === "application" && context.applicationId && <>
        <button onClick={() => setDialog({ type: "settings", applicationId: context.applicationId as string })}>Settings</button>
        <button onClick={() => setDialog({ type: "audiences", applicationId: context.applicationId as string })}>Access audiences</button>
        <button onClick={() => setDialog({ type: "agents", applicationId: context.applicationId as string })}>Agent identities</button>
      </>}
    </div>
    {dialog?.type === "create" && <CreateApplicationDialog onClose={() => setDialog(null)} />}
    {dialog?.type === "settings" && <ApplicationSettingsDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
    {dialog?.type === "audiences" && <AccessAudiencesDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
    {dialog?.type === "agents" && <AgentIdentitiesDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
  </>;
}

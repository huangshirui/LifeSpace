import { useEffect, useState } from "react";
import "./credential-governance.css";

type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type DataEnvelope<T> = { data: T };

export type AgentCredentialTarget = { id: string; displayName: string };

type AgentCredential = {
  id: string;
  agentId: string;
  applicationId: string;
  displayPrefix: string;
  lastFour: string;
  label: string;
  scopes: string[];
  audience: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

class AgentCredentialError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "AgentCredentialError";
  }
}

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new AgentCredentialError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new AgentCredentialError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
  return payload.data;
}

async function get<T>(path: string): Promise<T> {
  return readData<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));
}

async function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", intent: string, body: unknown): Promise<T> {
  return readData<T>(await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json", "x-lifespace-console-intent": intent },
    body: JSON.stringify(body),
  }));
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))];
}

function inputDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function isoDateTime(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export default function AgentCredentialsDialog({ applicationId, agent, onClose }: { applicationId: string; agent: AgentCredentialTarget; onClose: () => void }) {
  const [items, setItems] = useState<AgentCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [revealPath, setRevealPath] = useState<string>();
  const [editing, setEditing] = useState<AgentCredential>();
  const [label, setLabel] = useState("n8n");
  const [scopes, setScopes] = useState("resources:read\nresources:write");
  const [expiresAt, setExpiresAt] = useState("");

  const basePath = `/api/credential-governance/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agent.id)}/api-credentials`;

  async function load() {
    setLoading(true); setError(undefined);
    try { setItems(await get<AgentCredential[]>(basePath)); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [applicationId, agent.id]);

  function reset() {
    setEditing(undefined); setLabel("n8n"); setScopes("resources:read\nresources:write"); setExpiresAt("");
  }

  function beginReduce(item: AgentCredential) {
    setEditing(item); setLabel(item.label); setScopes(item.scopes.join("\n")); setExpiresAt(inputDateTime(item.expiresAt)); setRevealPath(undefined);
  }

  async function save() {
    setBusy(true); setError(undefined); setRevealPath(undefined);
    try {
      const values = parseScopes(scopes);
      if (editing) {
        await mutate<AgentCredential>(`${basePath}/${encodeURIComponent(editing.id)}`, "PATCH", "update-agent-api-credential", {
          label: label.trim(), scopes: values, expiresAt: isoDateTime(expiresAt),
          confirmApplicationId: applicationId, confirmAgentId: agent.id, confirmCredentialId: editing.id,
        });
      } else {
        const result = await mutate<{ credential: AgentCredential; revealPath: string }>(basePath, "POST", "create-agent-api-credential", {
          label: label.trim(), scopes: values, expiresAt: isoDateTime(expiresAt),
          confirmApplicationId: applicationId, confirmAgentId: agent.id,
        });
        setRevealPath(result.revealPath);
      }
      reset();
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function revoke(item: AgentCredential) {
    if (!window.confirm(`确认撤销 Agent credential ${item.id}（${item.displayPrefix}…${item.lastFour}）？使用它的 n8n/adapter 会立即无法认证。`)) return;
    setBusy(true); setError(undefined); setRevealPath(undefined);
    try {
      await mutate<{ revoked: true }>(`${basePath}/${encodeURIComponent(item.id)}`, "DELETE", "revoke-agent-api-credential", {
        confirmApplicationId: applicationId, confirmAgentId: agent.id, confirmCredentialId: item.id,
      });
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  const active = items.filter((item) => item.status === "active" && !item.revokedAt);
  const history = items.filter((item) => item.status !== "active" || item.revokedAt);
  const displayError = error instanceof AgentCredentialError ? error : error instanceof Error ? new AgentCredentialError(error.message) : undefined;

  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cp-dialog cgp-dialog" role="dialog" aria-modal="true" aria-label="Agent API credentials">
      <header className="cp-dialog-header"><div><div className="cp-eyebrow">Agent credential governance</div><h2>Agent API credentials</h2><p>{agent.displayName} · {agent.id}</p></div><button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="cp-dialog-body">
        <div className="cgp-warning"><strong>Credential ≠ Authority</strong><span>`lsp_agt_*` 只认证当前 Application + Agent Actor；直接模式只能使用 Agent 自己已有的 Authority，User 模式必须另外携带当前 `dlg_*`。</span></div>
        {revealPath && <div className="cgp-reveal-notice"><div><strong>一次性 Agent credential 已生成</strong><span>明文没有进入 React/JSON。请在 60 秒内打开隔离 reveal 页面并保存到 n8n/adapter。</span></div><a href={revealPath} target="_blank" rel="noreferrer" onClick={() => setRevealPath(undefined)}>Open one-time secret</a></div>}
        <div className="cgp-editor">
          <div className="cgp-form-grid"><label className="cp-field"><span>Label</span><input maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} /></label><label className="cp-field"><span>Expires at (optional)</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label></div>
          <label className="cp-field"><span>Scopes</span><textarea className="cgp-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} spellCheck={false} /><small>必须位于 Application scope ceiling 内。已有 credential 只能收窄 scopes / 缩短 expiry，Identity 会再次强制校验。</small></label>
          <div className="cgp-actions">{editing && <button className="cp-secondary" disabled={busy} onClick={reset}>取消收窄</button>}<button className="cp-primary" disabled={busy || !label.trim() || !parseScopes(scopes).length} onClick={() => void save()}>{editing ? "Save reduction" : "Create credential"}</button></div>
        </div>
        {displayError && <div className="cp-notice cp-error"><strong>{displayError.code ?? "操作失败"}</strong><span>{displayError.message}</span>{displayError.requestId && <small>requestId: {displayError.requestId}</small>}</div>}
        <div className="cgp-section-title"><div><strong>Active credentials</strong><span>{active.length}</span></div></div>
        <div className="cgp-list">{loading ? <div className="cp-loading">正在读取 Agent credential metadata…</div> : active.length ? active.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.label}</strong><code>{item.displayPrefix}…{item.lastFour}</code><small>{item.scopes.join(" · ")} · {item.expiresAt ? `expires ${new Date(item.expiresAt).toLocaleString()}` : "no expiry"}</small></div><div className="cgp-actions"><button disabled={busy} onClick={() => beginReduce(item)}>Reduce</button><button className="cgp-danger" disabled={busy} onClick={() => void revoke(item)}>Revoke</button></div></div>) : <div className="cp-loading">当前没有 active Agent credential。</div>}</div>
        {!!history.length && <><div className="cgp-section-title"><div><strong>Revoked history</strong><span>{history.length}</span></div></div><div className="cgp-list cgp-muted">{history.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.label}</strong><code>{item.displayPrefix}…{item.lastFour}</code><small>revoked {item.revokedAt ? new Date(item.revokedAt).toLocaleString() : item.status}</small></div></div>)}</div></>}
      </div>
      <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}

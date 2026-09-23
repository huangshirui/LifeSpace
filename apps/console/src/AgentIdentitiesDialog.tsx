import { useEffect, useState } from "react";
import "./application-configuration.css";

type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type DataEnvelope<T> = { data: T };

type AgentIdentity = {
  id: string;
  applicationId: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  binding: {
    status: "active" | "revoked";
    createdAt: string;
    revokedAt: string | null;
  };
};

class AgentGovernanceError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "AgentGovernanceError";
  }
}

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new AgentGovernanceError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new AgentGovernanceError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
  return payload.data;
}

async function get<T>(path: string): Promise<T> {
  return readData<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));
}

async function mutate<T>(path: string, method: "POST" | "PATCH", intent: string, body: unknown): Promise<T> {
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

function ErrorNotice({ error }: { error?: unknown }) {
  if (!error) return null;
  const value = error instanceof AgentGovernanceError
    ? error
    : new AgentGovernanceError(error instanceof Error ? error.message : "Unknown error");
  return <div className="cp-notice cp-error"><strong>{value.code ?? "操作失败"}</strong><span>{value.message}</span>{value.requestId && <small>requestId: {value.requestId}</small>}</div>;
}

export default function AgentIdentitiesDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [editing, setEditing] = useState<AgentIdentity>();
  const [editName, setEditName] = useState("");
  const [editStatus, setEditStatus] = useState<"active" | "disabled">("active");
  const [globalConfirmed, setGlobalConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function load() {
    setLoading(true); setError(undefined);
    try {
      setAgents(await get<AgentIdentity[]>(`/api/agent-governance/applications/${encodeURIComponent(applicationId)}/agents`));
    } catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [applicationId]);

  async function createAgent() {
    if (!displayName.trim()) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<AgentIdentity>(`/api/agent-governance/applications/${encodeURIComponent(applicationId)}/agents`, "POST", "create-agent-identity", {
        displayName: displayName.trim(),
        confirmApplicationId: applicationId,
      });
      setDisplayName("");
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  function beginEdit(agent: AgentIdentity) {
    setEditing(agent);
    setEditName(agent.displayName);
    setEditStatus(agent.status);
    setGlobalConfirmed(false);
    setError(undefined);
  }

  async function saveAgent() {
    if (!editing || !editName.trim()) return;
    const statusChanged = editStatus !== editing.status;
    if (statusChanged && !globalConfirmed) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<AgentIdentity>(`/api/agent-governance/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(editing.id)}`, "PATCH", "update-agent-identity", {
        displayName: editName.trim(),
        ...(statusChanged ? { status: editStatus, confirmGlobalStatus: true } : {}),
        confirmApplicationId: applicationId,
        confirmAgentId: editing.id,
      });
      setEditing(undefined);
      setGlobalConfirmed(false);
      await load();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  const active = agents.filter((agent) => agent.binding.status === "active");
  const history = agents.filter((agent) => agent.binding.status !== "active");

  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cp-dialog" role="dialog" aria-modal="true" aria-label="Agent identities">
      <header className="cp-dialog-header">
        <div><div className="cp-eyebrow">Application control plane</div><h2>Agent identities</h2><p>管理 Identity 权威的稳定 Agent 身份。display name 与 status 属于全局 agt_* identity；Application binding 是独立关系。创建 Agent 不会自动授予 Space / Model 权限，也不会创建 Delegation。</p></div>
        <button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      <div className="cp-dialog-body">
        <div className="acp-warning"><strong>Agent identity ≠ Agent authority</strong><span>这里仅管理 agt_* 身份与 Application binding。真正的数据访问仍由 Delegation、Space/Data Grant、Application scope ceiling 与 Model Access 独立决定。</span></div>
        <div className="acp-inline-form">
          <label className="cp-field"><span>New Agent display name</span><input value={displayName} maxLength={100} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如 Scheduling Assistant" /></label>
          <button className="cp-primary" disabled={busy || !displayName.trim()} onClick={() => void createAgent()}>Create Agent</button>
        </div>

        {editing && <div className="acp-section">
          <div className="acp-section-title"><strong>Edit Agent</strong><span>{editing.id}</span></div>
          <div className="acp-form-grid">
            <label className="cp-field"><span>Global display name</span><input value={editName} maxLength={100} onChange={(event) => setEditName(event.target.value)} /><small>修改名称会更新此 agt_* identity，在其它 Application binding 中也会看到同一名称。</small></label>
            <label className="cp-field cp-compact"><span>Global status</span><select value={editStatus} onChange={(event) => { setEditStatus(event.target.value as "active" | "disabled"); setGlobalConfirmed(false); }}><option value="active">active</option><option value="disabled">disabled</option></select></label>
          </div>
          {editStatus !== editing.status && <div className="cp-danger-box"><strong>Global Agent status</strong><span>这不是当前 Application 的局部开关。disable/reactivate 会影响此 agt_* 的所有 Application bindings。</span></div>}
          {editStatus !== editing.status && <label className="cp-confirm"><input type="checkbox" checked={globalConfirmed} onChange={(event) => setGlobalConfirmed(event.target.checked)} /><span>我确认这是全局 Agent identity 状态变更。</span></label>}
          <div className="acp-inline-form"><button className="cp-secondary" disabled={busy} onClick={() => setEditing(undefined)}>取消</button><button className="cp-primary" disabled={busy || !editName.trim() || (editStatus !== editing.status && !globalConfirmed)} onClick={() => void saveAgent()}>Save Agent</button></div>
        </div>}

        <ErrorNotice error={error} />
        <div className="acp-section"><div className="acp-section-title"><strong>Active bindings</strong><span>{active.length}</span></div>{loading ? <div className="cp-loading">正在读取 Agent identities…</div> : active.length ? active.map((agent) => <div className="acp-audience" key={agent.id}><div><strong>{agent.displayName}</strong><code>{agent.id}</code><small>global {agent.status} · binding {agent.binding.status}</small></div><button disabled={busy} onClick={() => beginEdit(agent)}>Edit</button></div>) : <div className="cp-loading">当前没有 Agent identity。</div>}</div>
        {!!history.length && <div className="acp-section"><div className="acp-section-title"><strong>Binding history</strong><span>{history.length}</span></div>{history.map((agent) => <div className="acp-audience acp-muted" key={agent.id}><div><strong>{agent.displayName}</strong><code>{agent.id}</code><small>{agent.binding.status} {agent.binding.revokedAt ? `· ${new Date(agent.binding.revokedAt).toLocaleString()}` : ""}</small></div></div>)}</div>}
      </div>
      <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}

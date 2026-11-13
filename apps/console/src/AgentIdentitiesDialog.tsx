import { useEffect, useState } from "react";
import { ConsoleDialog } from "./ConsoleDialog";
import AgentCredentialsDialog from "./AgentCredentialsDialog";
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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentIdentity>();
  const [credentialAgent, setCredentialAgent] = useState<AgentIdentity>();
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
      setCreating(false);
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

  const cancelEditor = () => { if (!busy) { setCreating(false); setEditing(undefined); setDisplayName(""); setGlobalConfirmed(false); setError(undefined); } };
  const cancel = <button className="cp-secondary" disabled={busy} onClick={cancelEditor}>取消</button>;
  if (credentialAgent) return <AgentCredentialsDialog applicationId={applicationId} agent={credentialAgent} onClose={() => setCredentialAgent(undefined)} />;
  if (creating) return <ConsoleDialog key="create" compact busy={busy} title="Create Agent" description={applicationId}
    onClose={cancelEditor} footer={<>{cancel}<button className="cp-primary" disabled={busy || !displayName.trim()} onClick={() => void createAgent()}>{busy ? "创建中…" : "Create Agent"}</button></>}>
    <label className="cp-field"><span>Display name</span><input disabled={busy} value={displayName} maxLength={100} onChange={event => setDisplayName(event.target.value)} placeholder="例如 Scheduling Assistant" /></label>
    <small>创建身份不会自动授予 Space / Model 权限，也不会创建 Delegation。</small>
    <ErrorNotice error={error} />
  </ConsoleDialog>;
  if (editing) return <ConsoleDialog key="edit" compact busy={busy} title="Edit Agent" description={editing.displayName + " · " + editing.id}
    onClose={cancelEditor} footer={<>{cancel}<button className="cp-primary" disabled={busy || !editName.trim() || (editStatus !== editing.status && !globalConfirmed)} onClick={() => void saveAgent()}>{busy ? "保存中…" : "Save Agent"}</button></>}>
    <fieldset className="console-editor-fields" disabled={busy}>
      <label className="cp-field"><span>Global display name</span><input value={editName} maxLength={100} onChange={event => { setEditName(event.target.value); setGlobalConfirmed(false); }} /><small>其它 Application binding 中也会看到同一名称。</small></label>
      <label className="cp-field"><span>Global status</span><select value={editStatus} onChange={event => { setEditStatus(event.target.value as "active" | "disabled"); setGlobalConfirmed(false); }}><option value="active">active</option><option value="disabled">disabled</option></select></label>
      {editStatus !== editing.status && <div className="cp-danger-box"><strong>Global Agent status</strong><span>disable/reactivate 会影响此 agt_* 的所有 Application bindings。</span></div>}
      {editStatus !== editing.status && <label className="cp-confirm"><input type="checkbox" checked={globalConfirmed} onChange={event => setGlobalConfirmed(event.target.checked)} /><span>我确认这是全局 Agent identity 状态变更。</span></label>}
    </fieldset>
    <ErrorNotice error={error} />
  </ConsoleDialog>;
  return <ConsoleDialog key="list" busy={busy} title="Agent identities" description="管理当前 Application 的 Agent 身份与绑定。"
    onClose={onClose} footer={<button className="cp-secondary" disabled={busy} onClick={onClose}>关闭</button>}>
    <div className="acp-warning"><strong>Agent identity ≠ Agent authority</strong><span>数据访问仍由 Delegation、Space/Data Grant、Application scope ceiling 与 Model Access 决定。</span></div>
    <ErrorNotice error={error} />
    <div className="acp-section"><div className="acp-section-title"><strong>Active bindings · {active.length}</strong><button className="cp-primary" disabled={busy || loading} onClick={() => { setDisplayName(""); setError(undefined); setCreating(true); }}>New Agent</button></div>
      {loading ? <div className="cp-loading">正在读取 Agent identities…</div> : active.length ? active.map(agent => <div className="acp-audience" key={agent.id}><div><strong>{agent.displayName}</strong><code>{agent.id}</code><small>global {agent.status} · binding {agent.binding.status}</small></div><div className="acp-inline-form"><button disabled={busy} onClick={() => setCredentialAgent(agent)}>Credentials</button><button disabled={busy} onClick={() => beginEdit(agent)}>Edit</button></div></div>) : <div className="cp-loading">当前没有 Agent identity。</div>}
    </div>
    {!!history.length && <div className="acp-section"><div className="acp-section-title"><strong>Binding history</strong><span>{history.length}</span></div>{history.map(agent => <div className="acp-audience acp-muted" key={agent.id}><div><strong>{agent.displayName}</strong><code>{agent.id}</code><small>{agent.binding.status} {agent.binding.revokedAt ? "· " + new Date(agent.binding.revokedAt).toLocaleString() : ""}</small></div></div>)}</div>}
  </ConsoleDialog>;
}

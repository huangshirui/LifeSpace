import { useEffect, useMemo, useState } from "react";
import "./external-connections.css";

type DataEnvelope<T> = { data: T };
type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type Provider = { key: string; displayName: string; credential: { type: string; displayName: string }; resource: { type: string; displayName: string }; access: Array<"read" | "write"> };
type Connection = { id: string; spaceId: string; providerKey: string; displayName: string; access: "read" | "write" | null; status: "active" | "disabled" | "revoked"; managementMode: "dynamic" | "deployment"; resourceDiscovery: boolean; createdAt: string; updatedAt: string };
type Resource = { id: string; type: string; displayName: string };
type ExternalModelDefinition = { key: string; displayName: string; description: string | null; access: Array<"read" | "write">; schemaHash: string };
type ExternalBinding = {
  modelKey: string;
  registrationId: string;
  definitionKey: string | null;
  spaceId: string;
  connectionId: string;
  displayName: string;
  status: "active" | "disabled" | "degraded";
  declaredAccess: "read" | "write";
  schemaHash: string;
  schemaObservedAt: string;
  lastErrorCode: string | null;
};

class ExternalUiError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) { super(message); this.name = "ExternalUiError"; }
}
async function data<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new ExternalUiError(error?.message ?? `HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new ExternalUiError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
  return payload.data;
}
async function get<T>(path: string): Promise<T> {
  return data<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));
}
async function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", intent: string, body?: unknown, confirmation?: string): Promise<T> {
  return data<T>(await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-lifespace-console-intent": intent,
      ...(confirmation ? { "x-lifespace-console-confirm-connection-id": confirmation } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
function currentSpaceId(): string | null {
  const match = /^\/spaces\/(spc_[A-Za-z0-9_-]+)\/?$/u.exec(window.location.pathname);
  return match?.[1] ?? null;
}
function Message({ error }: { error: unknown }) {
  if (!error) return null;
  const value = error instanceof ExternalUiError ? error : new ExternalUiError(error instanceof Error ? error.message : "Unknown error");
  return <div className="ext-message ext-error"><strong>{value.code ?? "操作失败"}</strong><span>{value.message}</span>{value.requestId && <small>requestId: {value.requestId}</small>}</div>;
}

export default function ExternalConnectionsOverlay() {
  const spaceId = currentSpaceId();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"connections" | "binding">("connections");
  if (!spaceId) return null;
  return <>
    <div className="ext-launcher"><button onClick={() => setOpen(true)}>External data</button></div>
    {open && <ExternalDialog spaceId={spaceId} tab={tab} setTab={setTab} onClose={() => setOpen(false)} />}
  </>;
}

function ExternalDialog({ spaceId, tab, setTab, onClose }: { spaceId: string; tab: "connections" | "binding"; setTab: (tab: "connections" | "binding") => void; onClose: () => void }) {
  return <div className="ext-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ext-dialog" role="dialog" aria-modal="true" aria-label="External data">
      <header><div><small>Space configuration</small><h2>External data</h2><p>连接外部数据源并绑定到已发布的 LifeSpace External Model。Connection 与凭据由平台管理，业务数据仍保留在 Provider。</p></div><button className="ext-close" onClick={onClose} aria-label="关闭">×</button></header>
      <nav><button className={tab === "connections" ? "active" : ""} onClick={() => setTab("connections")}>连接</button><button className={tab === "binding" ? "active" : ""} onClick={() => setTab("binding")}>模型绑定</button></nav>
      {tab === "connections" ? <ConnectionsPanel spaceId={spaceId} onReadyToBind={() => setTab("binding")} /> : <BindingPanel spaceId={spaceId} />}
    </section>
  </div>;
}

function ConnectionsPanel({ spaceId, onReadyToBind }: { spaceId: string; onReadyToBind: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providerKey, setProviderKey] = useState("");
  const [displayName, setDisplayName] = useState("Notion");
  const [token, setToken] = useState("");
  const [access, setAccess] = useState<"read" | "write">("write");
  const [rotate, setRotate] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();

  async function load() {
    setError(undefined);
    try {
      const [providerData, connectionData] = await Promise.all([
        get<{ items: Provider[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-providers`),
        get<{ items: Connection[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections`),
      ]);
      setProviders(providerData.items);
      setConnections(connectionData.items);
      if (!providerKey && providerData.items[0]) { setProviderKey(providerData.items[0].key); setDisplayName(providerData.items[0].displayName); }
    } catch (cause) { setError(cause); }
  }
  useEffect(() => { void load(); }, [spaceId]);
  const provider = providers.find((item) => item.key === providerKey);

  async function create() {
    if (!provider || !displayName.trim() || !token.trim()) return;
    setBusy("create"); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections`, "POST", "create-external-connection", {
        providerKey,
        displayName: displayName.trim(),
        credential: { type: provider.credential.type, token: token.trim() },
        access,
      });
      setToken("");
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function setStatus(connection: Connection, status: "active" | "disabled") {
    setBusy(connection.id); setError(undefined);
    try { await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connection.id}`, "PATCH", "update-external-connection", { status }); await load(); }
    catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function rotateToken(connection: Connection) {
    const next = rotate[connection.id]?.trim(); if (!next) return;
    setBusy(connection.id); setError(undefined);
    try {
      const descriptor = providers.find((item) => item.key === connection.providerKey);
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connection.id}`, "PATCH", "update-external-connection", { credential: { type: descriptor?.credential.type ?? "bearer_token", token: next } });
      setRotate((current) => ({ ...current, [connection.id]: "" }));
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function revoke(connection: Connection) {
    if (!window.confirm(`撤销 ${connection.displayName}？对应的动态凭据将从 Adapter Vault 删除，现有绑定会被禁用。`)) return;
    setBusy(connection.id); setError(undefined);
    try { await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connection.id}`, "DELETE", "revoke-external-connection", undefined, connection.id); await load(); }
    catch (cause) { setError(cause); } finally { setBusy(""); }
  }

  return <div className="ext-body">
    <section className="ext-card">
      <h3>添加连接</h3><p>Provider token 只用于本次请求并保存到私有 Adapter Vault；LifeSpace Core 不保存或回显明文。</p>
      <div className="ext-grid">
        <label><span>Provider</span><select value={providerKey} onChange={(event) => { const key = event.target.value; setProviderKey(key); const next = providers.find((item) => item.key === key); if (next) setDisplayName(next.displayName); }}>{providers.map((item) => <option key={item.key} value={item.key}>{item.displayName}</option>)}</select></label>
        <label><span>名称</span><input value={displayName} maxLength={100} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label className="wide"><span>{provider?.credential.displayName ?? "Credential"}</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="仅在创建/换 token 时提交" /></label>
        <label><span>能力上限</span><select value={access} onChange={(event) => setAccess(event.target.value as "read" | "write")}><option value="read">只读</option>{provider?.access.includes("write") && <option value="write">读写</option>}</select></label>
      </div>
      <button className="ext-primary" disabled={busy === "create" || !provider || !displayName.trim() || !token.trim()} onClick={() => void create()}>{busy === "create" ? "验证并连接中…" : "验证并添加连接"}</button>
    </section>

    <section className="ext-card"><div className="ext-section-head"><div><h3>当前连接</h3><p>deployment 类型来自部署配置，只能在这里启停；dynamic 类型可换 token 或撤销。</p></div>{connections.some((item) => item.status === "active") && <button onClick={onReadyToBind}>去绑定模型 →</button>}</div>
      {!connections.length && <div className="ext-empty">还没有外部连接。</div>}
      <div className="ext-list">{connections.map((connection) => <article key={connection.id} className="ext-connection"><div className="ext-connection-main"><strong>{connection.displayName}</strong><code>{connection.id}</code><div className="ext-badges"><span>{connection.providerKey}</span><span>{connection.access ?? "unknown"}</span><span>{connection.status}</span><span>{connection.managementMode}</span></div></div>
        <div className="ext-actions">
          {connection.status === "active" ? <button disabled={busy === connection.id} onClick={() => void setStatus(connection, "disabled")}>Disable</button> : connection.status === "disabled" && <button disabled={busy === connection.id} onClick={() => void setStatus(connection, "active")}>Enable</button>}
          {connection.managementMode === "dynamic" && connection.status !== "revoked" && <><input type="password" autoComplete="off" placeholder="新 token" value={rotate[connection.id] ?? ""} onChange={(event) => setRotate((current) => ({ ...current, [connection.id]: event.target.value }))} /><button disabled={busy === connection.id || !(rotate[connection.id]?.trim())} onClick={() => void rotateToken(connection)}>换 token</button><button className="danger" disabled={busy === connection.id} onClick={() => void revoke(connection)}>撤销</button></>}
        </div>
      </article>)}</div>
    </section>
    <Message error={error} />
  </div>;
}

function BindingPanel({ spaceId }: { spaceId: string }) {
  const [models, setModels] = useState<ExternalModelDefinition[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [bindings, setBindings] = useState<ExternalBinding[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [definitionKey, setDefinitionKey] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [resourceBusy, setResourceBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);

  async function load() {
    setError(undefined);
    try {
      const [definitionData, connectionData, bindingData] = await Promise.all([
        get<{ items: ExternalModelDefinition[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-model-definitions`),
        get<{ items: Connection[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections`),
        get<{ items: ExternalBinding[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-models`),
      ]);
      setModels(definitionData.items);
      setConnections(connectionData.items);
      setBindings(bindingData.items);
    } catch (cause) { setError(cause); }
  }
  useEffect(() => { void load(); }, [spaceId]);

  const discoverableConnections = useMemo(
    () => connections.filter((item) => item.status === "active" && item.resourceDiscovery),
    [connections],
  );
  const selectedConnection = useMemo(() => discoverableConnections.find((item) => item.id === connectionId), [discoverableConnections, connectionId]);
  const selectedDefinition = useMemo(() => models.find((item) => item.key === definitionKey), [models, definitionKey]);
  const writeAllowed = selectedConnection?.access === "write" && selectedDefinition?.access.includes("write") === true;
  useEffect(() => { if (!writeAllowed && access === "write") setAccess("read"); }, [writeAllowed, access]);

  async function discover(search = query) {
    if (!connectionId) return;
    setResourceBusy(true); setError(undefined); setResourceId("");
    try {
      const params = new URLSearchParams({ limit: "100" }); if (search.trim()) params.set("query", search.trim());
      const result = await get<{ items: Resource[]; nextCursor: string | null }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connectionId}/resources?${params}`);
      setResources(result.items);
    } catch (cause) { setError(cause); setResources([]); } finally { setResourceBusy(false); }
  }
  async function bind() {
    if (!definitionKey || !connectionId || !resourceId) return;
    setBusy("bind"); setError(undefined); setSaved(false);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models`, "POST", "bind-external-model", { definitionKey, connectionId, resourceId, declaredAccess: access });
      setSaved(true);
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function refresh(binding: ExternalBinding) {
    setBusy(binding.registrationId); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}/refresh`, "POST", "refresh-external-model-binding", {});
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function setBindingAccess(binding: ExternalBinding, declaredAccess: "read" | "write") {
    setBusy(binding.registrationId); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`, "PATCH", "update-external-model-binding", { declaredAccess });
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function disable(binding: ExternalBinding) {
    if (!window.confirm(`禁用 ${binding.displayName}？Provider 数据不会删除；恢复时请在上方重新选择同一 Connection 与 Provider Resource 进行绑定。`)) return;
    setBusy(binding.registrationId); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`, "PATCH", "update-external-model-binding", { status: "disabled" });
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }

  return <div className="ext-body">
    <section className="ext-card"><h3>绑定 External Model</h3><p>选择已发布业务模型、Connection 和 Provider Resource。字段 Schema 在绑定时由 Adapter 自动发现并形成最新 snapshot；disabled binding 也通过这里重新绑定同一资源恢复。</p>
      <div className="ext-grid">
        <label><span>业务模型</span><select value={definitionKey} onChange={(event) => { setDefinitionKey(event.target.value); setSaved(false); }}><option value="">选择 External Model</option>{models.map((item) => <option key={item.key} value={item.key}>{item.displayName} · {item.key}</option>)}</select></label>
        <label><span>Connection</span><select value={connectionId} onChange={(event) => { setConnectionId(event.target.value); setResources([]); setResourceId(""); setSaved(false); }}><option value="">选择动态连接</option>{discoverableConnections.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.access}</option>)}</select></label>
        <label className="wide"><span>搜索 Provider Resource</span><div className="ext-inline"><input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="例如 Health" /><button disabled={!connectionId || resourceBusy} onClick={() => void discover()}>{resourceBusy ? "发现中…" : "发现 Data Sources"}</button></div></label>
        <label className="wide"><span>Data Source</span><select value={resourceId} onChange={(event) => { setResourceId(event.target.value); setSaved(false); }}><option value="">{resources.length ? "选择 Data Source" : "先发现 Data Sources"}</option>{resources.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.id}</option>)}</select></label>
        <label><span>绑定能力</span><select value={access} onChange={(event) => setAccess(event.target.value as "read" | "write")}><option value="read">只读</option>{writeAllowed && <option value="write">读写</option>}</select></label>
      </div>
      {selectedDefinition?.description && <p>{selectedDefinition.description}</p>}
      <button className="ext-primary" disabled={busy === "bind" || !definitionKey || !connectionId || !resourceId} onClick={() => void bind()}>{busy === "bind" ? "绑定并发现字段中…" : "绑定并发现字段"}</button>
      {saved && <div className="ext-message ext-success"><strong>配置已更新</strong><span>Provider Schema 已自动发现，可继续在下方维护现有绑定。</span></div>}
      {!models.length && <div className="ext-empty">还没有已发布的 External Model Definition；请先在 Models 中注册外部模型。</div>}
      {!discoverableConnections.length && <div className="ext-empty">还没有可用于资源发现的动态连接；请先在“连接”页添加。</div>}
    </section>

    <section className="ext-card"><div className="ext-section-head"><div><h3>当前模型绑定</h3><p>这里维护同一套 External Data binding；不再存在第二个 External bindings 控制面。</p></div></div>
      {!bindings.length && <div className="ext-empty">当前 Space 还没有 External Model binding。</div>}
      <div className="ext-list">{bindings.map((binding) => {
        const connection = connections.find((item) => item.id === binding.connectionId);
        const definition = models.find((item) => item.key === binding.definitionKey);
        const canWrite = connection?.status === "active" && connection.access === "write" && definition?.access.includes("write") === true;
        const unavailable = busy === binding.registrationId;
        return <article className="ext-connection" key={binding.registrationId}>
          <div className="ext-connection-main"><strong>{binding.displayName}</strong><code>{binding.modelKey}</code><div className="ext-badges"><span>{binding.status}</span><span>{binding.declaredAccess}</span><span>{connection?.displayName ?? binding.connectionId}</span></div></div>
          <small>Schema observed: {binding.schemaObservedAt || "—"}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small>
          {binding.status === "disabled" && <small>恢复：在上方选择原业务模型、Connection 与 Provider Resource 后重新绑定。</small>}
          <div className="ext-actions">
            <button disabled={unavailable || binding.status === "disabled"} onClick={() => void refresh(binding)}>Refresh schema</button>
            <button disabled={unavailable || binding.status === "disabled" || binding.declaredAccess === "read"} onClick={() => void setBindingAccess(binding, "read")}>Set read</button>
            <button disabled={unavailable || binding.status === "disabled" || binding.declaredAccess === "write" || !canWrite} onClick={() => void setBindingAccess(binding, "write")}>Set write</button>
            <button className="danger" disabled={unavailable || binding.status === "disabled"} onClick={() => void disable(binding)}>Disable</button>
          </div>
        </article>;
      })}</div>
    </section>
    <Message error={error} />
  </div>;
}

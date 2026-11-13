import { useEffect, useMemo, useState } from "react";
import { ConsoleDialog } from "./ConsoleDialog";
import { SearchableSelect } from "./SearchableSelect";
import "./external-connections.css";

const matchesChoice = (row: { id: string; name: string }, query: string) => (row.name + " " + row.id).toLowerCase().includes(query.trim().toLowerCase());

type DataEnvelope<T> = { data: T };
type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type Provider = { key: string; displayName: string; credential: { type: string; displayName: string }; resource: { type: string; displayName: string }; access: Array<"read" | "write"> };
type Connection = { id: string; spaceId: string; providerKey: string; displayName: string; access: "read" | "write" | null; status: "active" | "disabled" | "revoked"; resourceDiscovery: boolean; createdAt: string; updatedAt: string };
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
type ExternalField = {
  key: string;
  title: string;
  type: string;
  nullable: boolean;
  readable: boolean;
  writable: boolean;
  operators: string[];
  sortable: boolean;
  values?: string[];
};
type ExternalBindingDetail = {
  modelKey: string;
  registrationId: string;
  spaceId: string;
  connectionId: string;
  schemaHash: string;
  schemaObservedAt: string;
  status: "active" | "disabled" | "degraded";
  fields: ExternalField[];
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
  const [editor, setEditor] = useState<"create" | Connection>();
  const [providerQuery, setProviderQuery] = useState("");
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
      setToken(""); setEditor(undefined);
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function setStatus(connection: Connection, status: "active" | "disabled") {
    setBusy(connection.id); setError(undefined);
    try { await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connection.id}`, "PATCH", "update-external-connection", { status }); await load(); }
    catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function rotateToken(connection: Connection) {
    const next = token.trim(); if (!next) return;
    setBusy(connection.id); setError(undefined);
    try {
      const descriptor = providers.find((item) => item.key === connection.providerKey);
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connection.id}`, "PATCH", "update-external-connection", { credential: { type: descriptor?.credential.type ?? "bearer_token", token: next } });
      setToken(""); setEditor(undefined);
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function revoke(connection: Connection) {
    if (!window.confirm(`撤销 ${connection.displayName}？对应的动态凭据将从 Adapter Vault 删除，现有绑定会被禁用。`)) return;
    setBusy(connection.id); setError(undefined);
    try { await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connection.id}`, "DELETE", "revoke-external-connection", undefined, connection.id); await load(); }
    catch (cause) { setError(cause); } finally { setBusy(""); }
  }

  function beginCreate() {
    const first = providers[0];
    setProviderKey(first?.key ?? ""); setDisplayName(first?.displayName ?? "");
    setAccess(first?.access.includes("write") ? "write" : "read");
    setProviderQuery(""); setToken(""); setError(undefined); setEditor("create");
  }
  const cancelEditor = () => { if (!busy) { setEditor(undefined); setToken(""); setError(undefined); } };
  const cancel = <button className="cp-secondary" disabled={!!busy} onClick={cancelEditor}>取消</button>;
  if (editor === "create") return <ConsoleDialog key="create" compact busy={!!busy} title="添加连接" description="Provider token 只用于本次请求并保存到私有 Adapter Vault；LifeSpace Core 不保存或回显明文。" onClose={cancelEditor}
    footer={<>{cancel}<button className="cp-primary" disabled={!!busy || !provider || !displayName.trim() || !token.trim()} onClick={() => void create()}>{busy ? "验证并连接中…" : "验证并添加连接"}</button></>}>
    <fieldset className="console-editor-fields" disabled={!!busy}>
      <SearchableSelect label="Provider" value={providerKey} options={providers.map(item => ({ id: item.key, name: item.displayName })).filter(item => matchesChoice(item, providerQuery))}
        query={providerQuery} onQueryChange={setProviderQuery} onChange={key => { setProviderKey(key); const next = providers.find(item => item.key === key); setDisplayName(next?.displayName ?? ""); setToken(""); setAccess(next?.access.includes("write") ? "write" : "read"); }} />
      <label className="cp-field"><span>名称</span><input value={displayName} maxLength={100} onChange={event => setDisplayName(event.target.value)} /></label>
      <label className="cp-field"><span>{provider?.credential.displayName ?? "Credential"}</span><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="仅在创建/换 token 时提交" /></label>
      <label className="cp-field"><span>能力上限</span><select value={access} onChange={event => setAccess(event.target.value as "read" | "write")}><option value="read">只读</option>{provider?.access.includes("write") && <option value="write">读写</option>}</select></label>
    </fieldset>
    <Message error={error} />
  </ConsoleDialog>;
  if (editor) return <ConsoleDialog key={editor.id} compact busy={!!busy} title="更换连接 Token" description={editor.displayName + " · " + editor.id} onClose={cancelEditor}
    footer={<>{cancel}<button className="cp-primary" disabled={!!busy || !token.trim()} onClick={() => void rotateToken(editor)}>{busy ? "验证中…" : "验证并更换 Token"}</button></>}>
    <label className="cp-field"><span>新 Token</span><input type="password" autoComplete="off" disabled={!!busy} value={token} onChange={event => setToken(event.target.value)} /></label>
    <Message error={error} />
  </ConsoleDialog>;
  return <div className="ext-body">
    <section className="ext-card"><div className="ext-section-head"><div><h3>当前连接</h3><p>管理当前 Space 的连接，可启停、更换 Token 或撤销。</p></div><div className="ext-heading-actions"><button className="cp-primary" disabled={!!busy || !providers.length} onClick={beginCreate}>添加连接</button>{connections.some(item => item.status === "active") && <button disabled={!!busy} onClick={onReadyToBind}>去绑定模型 →</button>}</div></div>
      {!connections.length && <div className="ext-empty">还没有外部连接。</div>}
      <div className="ext-list">{connections.map((connection) => <article key={connection.id} className="ext-connection"><div className="ext-connection-main"><strong>{connection.displayName}</strong><code>{connection.id}</code><div className="ext-badges"><span>{connection.providerKey}</span><span>{connection.access ?? "unknown"}</span><span>{connection.status}</span></div></div>
        <div className="ext-actions">
          {connection.status === "active" ? <button disabled={!!busy} onClick={() => void setStatus(connection, "disabled")}>Disable</button> : connection.status === "disabled" && <button disabled={!!busy} onClick={() => void setStatus(connection, "active")}>Enable</button>}
          {connection.status !== "revoked" && <><button disabled={!!busy} onClick={() => { setToken(""); setError(undefined); setEditor(connection); }}>换 token</button><button className="danger" disabled={!!busy} onClick={() => void revoke(connection)}>撤销</button></>}
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
  const [discovery, setDiscovery] = useState<{ scope: string; rows: Resource[]; loading: boolean; error?: unknown; nextCursor?: string | null }>({ scope: "", rows: [], loading: false });
  const [editing, setEditing] = useState(false);
  const [definitionQuery, setDefinitionQuery] = useState("");
  const [connectionQuery, setConnectionQuery] = useState("");
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const [definitionKey, setDefinitionKey] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");

  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [expandedRegistrationId, setExpandedRegistrationId] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState("");
  const [bindingDetails, setBindingDetails] = useState<Record<string, ExternalBindingDetail | undefined>>({});

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

  const discoveryScope = JSON.stringify([spaceId, connectionId, query.trim(), discoveryRetry]);
  useEffect(() => {
    if (!editing || !selectedConnection) return;
    let current = true;
    setDiscovery({ scope: discoveryScope, rows: [], loading: true });
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "100" });
      if (query.trim()) params.set("query", query.trim());
      void get<{ items: Resource[]; nextCursor: string | null }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-connections/${connectionId}/resources?${params}`).then(result => {
        if (current) setDiscovery({ scope: discoveryScope, rows: result.items, nextCursor: result.nextCursor, loading: false });
      }).catch(cause => {
        if (current) setDiscovery({ scope: discoveryScope, rows: [], loading: false, error: cause });
      });
    }, 350);
    return () => { current = false; window.clearTimeout(timer); };
  }, [editing, selectedConnection?.id, discoveryScope]);
  const discoveryCurrent = discovery.scope === discoveryScope;
  const resourceBusy = !!selectedConnection && (!discoveryCurrent || discovery.loading);
  const resources = discoveryCurrent ? discovery.rows : [];
  const resourceError = discoveryCurrent ? discovery.error : undefined;

  function beginBinding() {
    setDefinitionKey(""); setConnectionId(""); setResourceId(""); setAccess("read");
    setDefinitionQuery(""); setConnectionQuery(""); setQuery("");
    setDiscovery({ scope: "", rows: [], loading: false }); setError(undefined); setSaved(false); setEditing(true);
  }
  const cancelEditor = () => { if (!busy) { setEditing(false); setResourceId(""); setError(undefined); } };
  async function bind() {
    if (!selectedDefinition || !selectedConnection || !resourceId || resourceBusy || resourceError || (access === "write" && !writeAllowed)) return;
    setBusy("bind"); setError(undefined); setSaved(false);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models`, "POST", "bind-external-model", { definitionKey, connectionId, resourceId, declaredAccess: access });
      setSaved(true); setEditing(false);
      await load();
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function loadBindingDetail(binding: ExternalBinding) {
    setDetailBusy(binding.registrationId); setError(undefined);
    try {
      const detail = await get<ExternalBindingDetail>(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`);
      setBindingDetails((current) => ({ ...current, [binding.registrationId]: detail }));
    } catch (cause) { setError(cause); }
    finally { setDetailBusy(""); }
  }
  async function toggleBindingDetail(binding: ExternalBinding) {
    if (expandedRegistrationId === binding.registrationId) {
      setExpandedRegistrationId(null);
      return;
    }
    setExpandedRegistrationId(binding.registrationId);
    const current = bindingDetails[binding.registrationId];
    if (!current || current.schemaHash !== binding.schemaHash || current.status !== binding.status) await loadBindingDetail(binding);
  }
  async function refresh(binding: ExternalBinding) {
    setBusy(binding.registrationId); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}/refresh`, "POST", "refresh-external-model-binding", {});
      setBindingDetails((current) => ({ ...current, [binding.registrationId]: undefined }));
      await load();
      if (expandedRegistrationId === binding.registrationId) await loadBindingDetail(binding);
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function setBindingAccess(binding: ExternalBinding, declaredAccess: "read" | "write") {
    setBusy(binding.registrationId); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`, "PATCH", "update-external-model-binding", { declaredAccess });
      setBindingDetails((current) => ({ ...current, [binding.registrationId]: undefined }));
      await load();
      if (expandedRegistrationId === binding.registrationId) await loadBindingDetail(binding);
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }
  async function disable(binding: ExternalBinding) {
    if (!window.confirm(`禁用 ${binding.displayName}？Provider 数据不会删除；恢复时请通过“绑定模型”重新选择同一 Connection 与 Provider Resource。`)) return;
    setBusy(binding.registrationId); setError(undefined);
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`, "PATCH", "update-external-model-binding", { status: "disabled" });
      setBindingDetails((current) => ({ ...current, [binding.registrationId]: undefined }));
      await load();
      if (expandedRegistrationId === binding.registrationId) await loadBindingDetail(binding);
    } catch (cause) { setError(cause); } finally { setBusy(""); }
  }

  if (editing) return <ConsoleDialog key="binding" compact busy={!!busy} title="绑定 External Model"
    description="选择已发布业务模型、Connection 和 Provider Resource；disabled binding 也通过这里重新绑定同一资源恢复。" onClose={cancelEditor}
    footer={<><button className="cp-secondary" disabled={!!busy} onClick={cancelEditor}>取消</button><button className="cp-primary"
      disabled={!!busy || !selectedDefinition || !selectedConnection || !resourceId || resourceBusy || !!resourceError || (access === "write" && !writeAllowed)}
      onClick={() => void bind()}>{busy ? "绑定并发现字段中…" : "绑定并发现字段"}</button></>}>
    <fieldset className="console-editor-fields" disabled={!!busy}>
      <SearchableSelect label="业务模型" value={definitionKey} options={models.map(item => ({ id: item.key, name: item.displayName })).filter(item => matchesChoice(item, definitionQuery))}
        query={definitionQuery} onQueryChange={setDefinitionQuery} onChange={setDefinitionKey} />
      <SearchableSelect label="Connection" value={connectionId} options={discoverableConnections.map(item => ({ id: item.id, name: item.displayName })).filter(item => matchesChoice(item, connectionQuery))}
        query={connectionQuery} onQueryChange={setConnectionQuery} onChange={id => { setConnectionId(id); setResourceId(""); setQuery(""); setDiscovery({ scope: "", rows: [], loading: false }); }} />
      <SearchableSelect key={connectionId} label="Data Source" value={resourceId} options={resources.map(item => ({ id: item.id, name: item.displayName }))}
        query={query} onQueryChange={setQuery} onChange={setResourceId} maxLength={200} loading={resourceBusy} disabled={!selectedConnection} placeholder="搜索并选择 Provider Resource" />
      {resourceError ? <><Message error={resourceError} /><button className="cp-secondary" type="button" onClick={() => { setResourceId(""); setDiscoveryRetry(n => n + 1); }}>重试</button></> : null}
      {discoveryCurrent && discovery.nextCursor && <small>结果超过 100 条，请缩小搜索范围。</small>}
      <label className="cp-field"><span>绑定能力</span><select value={access} onChange={event => setAccess(event.target.value as "read" | "write")}><option value="read">只读</option>{writeAllowed && <option value="write">读写</option>}</select></label>
      {selectedDefinition?.description && <small>{selectedDefinition.description}</small>}
    </fieldset>
    <Message error={error} />
  </ConsoleDialog>;
  return <div className="ext-body">
    <section className="ext-card"><div className="ext-section-head"><div><h3>当前模型绑定</h3><p>这里维护同一套 External Data binding；展开“查看字段”读取 Core 已保存的最新 schema snapshot，不会触发 Provider 请求。</p></div><button className="ext-primary" disabled={!!busy || !models.length || !discoverableConnections.length} onClick={beginBinding}>绑定模型</button></div>
      {saved && <div className="ext-message ext-success"><strong>配置已更新</strong><span>Provider Schema 已自动发现。</span></div>}
      {!models.length && <div className="ext-empty">还没有已发布的 External Model Definition；请先在 Models 中注册外部模型。</div>}
      {!discoverableConnections.length && <div className="ext-empty">还没有可用于资源发现的连接；请先在“连接”页添加。</div>}
      {!bindings.length && <div className="ext-empty">当前 Space 还没有 External Model binding。</div>}
      <div className="ext-list">{bindings.map((binding) => {
        const connection = connections.find((item) => item.id === binding.connectionId);
        const definition = models.find((item) => item.key === binding.definitionKey);
        const canWrite = connection?.status === "active" && connection.access === "write" && definition?.access.includes("write") === true;
        const unavailable = !!busy;
        const expanded = expandedRegistrationId === binding.registrationId;
        const detail = bindingDetails[binding.registrationId];
        return <article className="ext-connection" key={binding.registrationId}>
          <div className="ext-connection-main"><strong>{binding.displayName}</strong><code>{binding.modelKey}</code><div className="ext-badges"><span>{binding.status}</span><span>{binding.declaredAccess}</span><span>{connection?.displayName ?? binding.connectionId}</span></div></div>
          <small>Schema observed: {binding.schemaObservedAt || "—"}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small>
          {binding.status === "disabled" && <small>恢复：通过“绑定模型”选择原业务模型、Connection 与 Provider Resource 后重新绑定。</small>}
          <div className="ext-actions ext-binding-actions">
            <button disabled={detailBusy === binding.registrationId} onClick={() => void toggleBindingDetail(binding)}>{detailBusy === binding.registrationId ? "读取字段中…" : expanded ? "收起字段" : "查看字段"}</button>
            <button disabled={unavailable || binding.status === "disabled"} onClick={() => void refresh(binding)}>Refresh schema</button>
            <button disabled={unavailable || binding.status === "disabled" || binding.declaredAccess === "read"} onClick={() => void setBindingAccess(binding, "read")}>Set read</button>
            <button disabled={unavailable || binding.status === "disabled" || binding.declaredAccess === "write" || !canWrite} onClick={() => void setBindingAccess(binding, "write")}>Set write</button>
            <button className="danger" disabled={unavailable || binding.status === "disabled"} onClick={() => void disable(binding)}>Disable</button>
          </div>
          {expanded && <div className="ext-schema-detail">
            {!detail && detailBusy !== binding.registrationId && <div className="ext-empty">字段详情暂不可用，可重试“查看字段”。</div>}
            {detail && <>
              <div className="ext-schema-head"><div><strong>Provider fields</strong><small>{detail.fields.length} fields · snapshot {detail.schemaHash.slice(0, 12)}…</small></div><small>这是配置态 snapshot；运行时消费者仍以 Space Discovery 为准。</small></div>
              <div className="ext-field-table" role="table" aria-label="External Provider fields">
                <div className="ext-field-row ext-field-header" role="row"><span>字段</span><span>类型</span><span>读</span><span>写</span><span>筛选</span><span>排序</span></div>
                {detail.fields.map((field) => <div className="ext-field-row" role="row" key={field.key}>
                  <div className="ext-field-name"><strong>{field.title}</strong><code>{field.key}</code>{field.values?.length ? <small>values: {field.values.join(", ")}</small> : null}</div>
                  <span>{field.type}{field.nullable ? " · nullable" : ""}</span>
                  <span>{field.readable ? "✓" : "—"}</span>
                  <span>{field.writable ? "✓" : "—"}</span>
                  <span title={field.operators.join(", ")}>{field.operators.length ? field.operators.join(", ") : "—"}</span>
                  <span>{field.sortable ? "✓" : "—"}</span>
                </div>)}
              </div>
            </>}
          </div>}
        </article>;
      })}</div>
    </section>
    <Message error={error} />
  </div>;
}

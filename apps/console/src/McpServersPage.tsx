import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "./mcp-servers.css";

type Operation = string;
type Selection = { modelKey: string; operations: Operation[] };
type ManifestModel = Selection & { modelVersion: number; schemaHash: string };
type Revision = { revision: number; manifestHash: string; publishedAt: string; publishedByUserId: string; manifest: { models: ManifestModel[] } };
type Server = {
  id: string; path: string; name: string; description: string;
  status: "draft" | "published" | "withdrawn";
  draftRevision: number; publishedRevision: number | null;
  draft: { models: Selection[] };
  published: { revision: number; manifest: { models: ManifestModel[] }; manifestHash: string; publishedAt: string } | null;
  createdAt: string; updatedAt: string;
};
type Model = { key: string; version: number; definition: { display?: { singular?: string }; access?: string[]; actions?: Record<string, { access?: string }> } };
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
const names: Record<string,string> = {
  get: "读取单条", query: "查询", create: "创建", update: "更新", delete: "删除",
};
function label(op: string) { return names[op] ?? (op.startsWith("action:") ? "动作 · " + op.slice(7) : op); }
function endpoint(id: string, suffix = "") { return "/api/mcp-servers/" + encodeURIComponent(id) + suffix; }
function status(value: Server["status"]) { return { draft: "草稿", published: "已发布", withdrawn: "已撤回" }[value]; }
async function api<T>(path: string, method: "GET" | "POST" | "PATCH" = "GET", payload?: unknown, intent?: string): Promise<T> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(method === "GET" ? {} : { "content-type": "application/json", "x-lifespace-console-intent": intent ?? "" }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(payload ?? {}) }),
  });
  const data = await res.json().catch(() => null) as Envelope<T> | null;
  if (!res.ok) throw new Error(data?.error?.message ?? "请求失败（HTTP " + res.status + "）");
  if (!data || data.data === undefined) throw new Error("服务器返回格式错误");
  return data.data;
}
function operations(model: Model | undefined) {
  if (!model) return [] as string[];
  const access = model.definition.access ?? [];
  const result: string[] = [];
  if (access.includes("read")) result.push("query", "get");
  if (access.includes("write")) result.push("create", "update", "delete");
  for (const [action, details] of Object.entries(model.definition.actions ?? {})) {
    if ((details.access === "read" || details.access === "write") && access.includes(details.access)) {
      result.push("action:" + action);
    }
  }
  return result;
}
function sameDraft(a: Selection[], b: Selection[]) {
  const normalize = (items: Selection[]) => JSON.stringify(items.map((m) => ({
    modelKey: m.modelKey, operations: [...m.operations].sort(),
  })).sort((x,y) => x.modelKey.localeCompare(y.modelKey)));
  return normalize(a) === normalize(b);
}


function validSelection(value: Selection[], models: Model[]): boolean {
  if (value.length === 0 || value.length > 32) return false;
  const modelMap = new Map(models.map((model) => [model.key, model]));
  return value.every((item) => {
    const available = operations(modelMap.get(item.modelKey));
    return item.operations.length > 0
      && item.operations.length <= 32
      && item.operations.every((operation) => available.includes(operation));
  });
}

function ModelSelectionEditor({
  models, value, onChange, disabled = false,
}: {
  models: Model[];
  value: Selection[];
  onChange: (next: Selection[]) => void;
  disabled?: boolean;
}) {
  const [pendingKey, setPendingKey] = useState("");
  const modelMap = useMemo(() => new Map(models.map((model) => [model.key, model])), [models]);
  const choices = models.filter((model) => !value.some((item) => item.modelKey === model.key) && operations(model).length > 0);

  function addModel() {
    const model = modelMap.get(pendingKey);
    if (!model || !operations(model).length || value.length >= 32) return;
    onChange([...value, { modelKey: model.key, operations: [] }]);
    setPendingKey("");
  }
  function toggle(modelKey: string, operation: string) {
    onChange(value.map((item) => {
      if (item.modelKey !== modelKey) return item;
      const checked = item.operations.includes(operation);
      if (!checked && item.operations.length >= 32) return item;
      return { ...item, operations: checked
        ? item.operations.filter((entry) => entry !== operation)
        : [...item.operations, operation] };
    }));
  }

  return <section className="mcp-panel">
    <div className="mcp-panel-head"><h2>模型与操作</h2><span>{value.length} 个模型</span></div>
    {value.map((item) => {
      const model = modelMap.get(item.modelKey);
      const allowed = operations(model);
      const choices = Array.from(new Set([...allowed, ...item.operations]));
      return <div className="mcp-model" key={item.modelKey}>
        <div className="mcp-model-head">
          <div><strong>{model?.definition.display?.singular ?? item.modelKey}</strong>
            <small>{item.modelKey}{model ? " · v" + model.version : " · 模型不可用"}</small></div>
          <button type="button" className="mcp-text-button" disabled={disabled}
            onClick={() => onChange(value.filter((entry) => entry.modelKey !== item.modelKey))}>移除</button>
        </div>
        <div className="mcp-operations">{choices.map((operation) => <label key={operation} className="mcp-check">
          <input type="checkbox" disabled={disabled || (!item.operations.includes(operation) && item.operations.length >= 32)}
            checked={item.operations.includes(operation)} onChange={() => toggle(item.modelKey, operation)} />
          {label(operation)}{!allowed.includes(operation) && <em>已失效</em>}
        </label>)}</div>
        {!item.operations.length && <p className="mcp-inline-help">请选择至少一项操作</p>}
      </div>;
    })}
    {!value.length && <div className="mcp-empty mcp-small">添加模型，再选择要开放的操作。</div>}
    <div className="mcp-add">
      <select aria-label="选择模型" value={pendingKey} disabled={disabled || value.length >= 32}
        onChange={(event) => setPendingKey(event.target.value)}>
        <option value="">选择已发布模型</option>
        {choices.map((model) => <option value={model.key} key={model.key}>
          {model.definition.display?.singular ?? model.key} · {model.key}
        </option>)}
      </select>
      <button type="button" className="secondary-button" disabled={disabled || !pendingKey || value.length >= 32}
        onClick={addModel}>添加模型</button>
    </div>
    {!choices.length && !value.length && <p className="mcp-caption">暂无可配置的已发布模型。</p>}
  </section>;
}

export default function McpServersPage({ serverKey, navigate }: { serverKey?: string; navigate: (path: string) => void }) {
  const [rows, setRows] = useState<Server[]>([]);
  const [selected, setSelected] = useState<Server>();
  const [models, setModels] = useState<Model[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [createDraft, setCreateDraft] = useState<Selection[]>([]);
  const [createdDraft, setCreatedDraft] = useState<Server | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Selection[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setNotice("");
    try {
      const catalog = await api<Server[]>("/api/mcp-servers");
      setRows(catalog);
      if (serverKey) {
        const [server, modelCatalog, history] = await Promise.all([
          api<Server>(endpoint(serverKey)), api<Model[]>("/api/models"),
          api<Revision[]>(endpoint(serverKey, "/revisions")),
        ]);
        setSelected(server); setModels(modelCatalog); setRevisions(history);
        setName(server.name); setDescription(server.description);
        setDraft(server.draft.models.map((model) => ({ modelKey: model.modelKey, operations: [...model.operations] })));
      } else {
        setSelected(undefined);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setLoading(false); }
  }, [serverKey]);
  useEffect(() => { void load(); }, [load]);

  const dirty = Boolean(selected && (selected.name !== name || selected.description !== description || !sameDraft(selected.draft.models, draft)));
  const createPublishable = validSelection(createDraft, models);
  const createSaveable = createDraft.length === 0 || validSelection(createDraft, models);
  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function loadCreateModels() {
    setCatalogStatus("loading");
    setError("");
    try {
      const modelCatalog = await api<Model[]>("/api/models");
      setModels(modelCatalog);
      setCatalogStatus("ready");
    } catch (cause) {
      setCatalogStatus("error");
      setError(cause instanceof Error ? cause.message : "模型列表加载失败");
    }
  }
  function beginCreate() {
    setCreating(true);
    setCreatedDraft(null);
    setNewName("");
    setNewDescription("");
    setCreateDraft([]);
    setError("");
    setNotice("");
    void loadCreateModels();
  }
  function cancelCreate() {
    if (busy) return;
    setCreating(false);
    setCreatedDraft(null);
    setError("");
    setNotice("");
    setCatalogStatus("idle");
    // Refresh the catalog: a failed publish may still have created a persisted draft.
    void load();
  }
  async function create(event: FormEvent<HTMLFormElement> | null, mode: "publish" | "draft") {
    event?.preventDefault();
    if (busy || createdDraft || catalogStatus !== "ready") return;
    if (newName.trim().length < 2) {
      setError("请输入至少两个字符的名称");
      return;
    }
    if (!createSaveable || (mode === "publish" && !createPublishable)) {
      setError("请为每个模型选择有效操作；发布时至少需要一个模型");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const server = await api<Server>("/api/mcp-servers", "POST", {
        name: newName.trim(), description: newDescription.trim(),
        draft: { models: createDraft },
      }, "create-mcp-server");
      // Persist the server identity in UI state before attempting the second API request.
      // If publishing fails, never create another server on Retry.
      setCreatedDraft(server);
      if (mode === "publish") {
        try {
          await api<Server>(endpoint(server.id, "/publish"), "POST", {
            expectedDraftRevision: server.draftRevision, confirmId: server.id,
          }, "publish-mcp-server");
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "发布结果未确认";
          // A response can be lost after Core committed the publication.
          // Read the canonical Server state before describing it as a draft.
          try {
            const current = await api<Server>(endpoint(server.id));
            setCreatedDraft(current);
            if (current.status === "published") {
              navigate("/mcp-servers/" + encodeURIComponent(current.id));
              return;
            }
            setError("Server 已保存为草稿，发布未完成：" + message);
          } catch {
            setError("Server 已创建，但发布结果未确认。请打开详情核对状态后再操作：" + message);
          }
          return;
        }
      }
      navigate("/mcp-servers/" + encodeURIComponent(server.id));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "请求失败";
      // On a network error the POST may already have committed; avoid claiming no draft exists.
      setError("创建结果未确认，请返回列表检查后再试，避免重复创建：" + message);
    } finally {
      setBusy(false);
    }
  }
  async function retryCreatePublish() {
    if (!createdDraft || busy) return;
    setBusy(true);
    setError("");
    try {
      const current = await api<Server>(endpoint(createdDraft.id));
      if (current.status === "published") {
        navigate("/mcp-servers/" + encodeURIComponent(current.id));
        return;
      }
      await api<Server>(endpoint(current.id, "/publish"), "POST", {
        expectedDraftRevision: current.draftRevision, confirmId: current.id,
      }, "publish-mcp-server");
      navigate("/mcp-servers/" + encodeURIComponent(current.id));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "发布结果未确认";
      setError("发布结果未确认，请打开详情核对状态：" + message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!selected || !dirty) return;
    await mutate(async () => {
      const server = await api<Server>(endpoint(selected.id), "PATCH", {
        expectedDraftRevision: selected.draftRevision,
        name: name.trim(), description: description.trim(),
        draft: { models: draft },
      }, "edit-mcp-server");
      setSelected(server);
      setName(server.name); setDescription(server.description);
      setDraft(server.draft.models);
      setNotice("草稿已保存");
    });
  }
  async function publish() {
    if (!selected || dirty || draft.length === 0) return;
    if (!window.confirm("发布 " + selected.path + " 的新版本？")) return;
    await mutate(async () => {
      await api<Server>(endpoint(selected.id, "/publish"), "POST", {
        expectedDraftRevision: selected.draftRevision, confirmId: selected.id,
      }, "publish-mcp-server");
      await load(); setNotice("发布成功，历史版本已保留");
    });
  }
  async function withdraw() {
    if (!selected || selected.status !== "published") return;
    if (!window.confirm("撤回 " + selected.path + " 的当前发布版本？")) return;
    await mutate(async () => {
      await api<Server>(endpoint(selected.id, "/withdraw"), "POST", { confirmId: selected.id }, "withdraw-mcp-server");
      await load(); setNotice("已撤回发布");
    });
  }

  return <div className="mcp-page">
    <header className="mcp-header">
      <div>
        <div className="eyebrow">Platform</div>
        <h1>{serverKey && selected ? selected.name : creating ? "新建 MCP Server" : "领域 MCP Servers"}</h1>
        <p>{serverKey && selected ? selected.path : creating ? "配置模型与操作，再创建并发布" : "管理领域工具的模型与操作发布目录"}</p>
      </div>
      <div className="mcp-toolbar">
        {serverKey
          ? <button type="button" className="secondary-button" onClick={() => navigate("/mcp-servers")}>返回列表</button>
          : creating
            ? <button type="button" className="secondary-button" disabled={busy} onClick={cancelCreate}>取消</button>
            : <button type="button" className="mcp-primary" onClick={beginCreate}>新建 Server</button>}
      </div>
    </header>

    {error && <div className="mcp-message mcp-error" role="alert">{error}</div>}
    {notice && <div className="mcp-message mcp-success" role="status">{notice}</div>}
    {loading ? <div className="mcp-panel mcp-empty">正在加载…</div> : !serverKey ? <>
      {creating ? <form className="mcp-create-form" onSubmit={(event) => void create(event, "publish")}>
        <section className="mcp-panel">
          <h2>基本信息</h2>
          <div className="mcp-create">
            <label>名称<input required minLength={2} maxLength={80} disabled={busy || Boolean(createdDraft)}
              value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：任务管理" /></label>
            <label className="mcp-full">描述（可选）<input maxLength={500} disabled={busy || Boolean(createdDraft)}
              value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="这个 Server 提供什么能力" /></label>
          </div>
        </section>
        {catalogStatus === "loading" && <div className="mcp-panel mcp-empty">正在加载已发布模型…</div>}
        {catalogStatus === "error" && <div className="mcp-panel mcp-empty">
          模型列表加载失败。<button type="button" className="secondary-button"
            onClick={() => void loadCreateModels()}>重新加载</button>
        </div>}
        {catalogStatus === "ready" && <ModelSelectionEditor models={models} value={createDraft}
          onChange={setCreateDraft} disabled={busy || Boolean(createdDraft)} />}
        {createdDraft ? <div className="mcp-panel mcp-recovery" role="status">
          <strong>Server 已创建</strong>
          <p>Server ID：<code>{createdDraft.id}</code>。如发布未完成，可重试；不会重复创建。</p>
          <div className="mcp-actions">
            <button type="button" className="mcp-primary" disabled={busy}
              onClick={() => void retryCreatePublish()}>重试发布</button>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={() => navigate("/mcp-servers/" + encodeURIComponent(createdDraft.id))}>管理草稿</button>
          </div>
        </div> : <div className="mcp-actions">
          <button type="submit" className="mcp-primary"
            disabled={busy || catalogStatus !== "ready" || !createPublishable}>创建并发布</button>
          <button type="button" className="secondary-button"
            disabled={busy || catalogStatus !== "ready" || !createSaveable}
            onClick={() => void create(null, "draft")}>保存草稿</button>
        </div>}
        <p className="mcp-caption">发布的是平台能力目录，不会自动部署 MCP Adapter 或授予客户端权限。</p>
      </form> : <section className="mcp-panel">
        <div className="mcp-table-scroll"><table className="mcp-table"><thead><tr><th>名称</th><th>路径</th><th>状态</th><th>版本</th><th /></tr></thead><tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><strong>{row.name}</strong><small>{row.description}</small></td>
            <td><code>{row.path}</code></td>
            <td><span className={"mcp-state mcp-" + row.status}>{status(row.status)}</span></td>
            <td>{row.publishedRevision ? "v" + row.publishedRevision : "—"}</td>
            <td><button type="button" className="mcp-text-button" onClick={() => navigate("/mcp-servers/" + encodeURIComponent(row.id))}>管理</button></td>
          </tr>)}
        </tbody></table></div>
        {!rows.length && <div className="mcp-empty">尚无 MCP Server。点击右上角新建。</div>}
      </section>}
      {!creating && <p className="mcp-caption">发布会保存平台目录，不会自动部署 MCP Adapter 或创建客户端权限。</p>}
    </> : selected ? <>
      <div className="mcp-summary">
        <div><span>状态</span><strong>{status(selected.status)}</strong></div>
        <div><span>已发布版本</span><strong>{selected.publishedRevision ? "v" + selected.publishedRevision : "—"}</strong></div>
        <div><span>草稿修订</span><strong>#{selected.draftRevision}</strong></div>
      </div>
      <section className="mcp-panel">
        <div className="mcp-panel-head"><h2>基本信息</h2><span>连接地址创建后不可修改</span></div>
        <div className="mcp-fields">
          <label>名称<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>路径<input value={selected.path} readOnly /></label>
          <label className="mcp-full">描述<input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        </div>
      </section>
      <ModelSelectionEditor models={models} value={draft} onChange={setDraft} disabled={busy} />
      <div className="mcp-actions">
        <button type="button" className="mcp-primary" disabled={busy || !dirty || draft.some((m) => !m.operations.length)} onClick={() => void save()}>保存草稿</button>
        <button type="button" className="secondary-button" disabled={busy || dirty || !draft.length} onClick={() => void publish()}>发布新版本</button>
        {selected.status === "published" && <button type="button" className="mcp-danger" disabled={busy} onClick={() => void withdraw()}>撤回发布</button>}
        {dirty && <span className="mcp-hint">请先保存草稿，再发布</span>}
      </div>
      <section className="mcp-panel">
        <h2>已发布版本</h2>
        {revisions.length ? <div className="mcp-table-scroll"><table className="mcp-table"><thead><tr><th>版本</th><th>发布时间</th><th>模型</th><th>摘要</th></tr></thead><tbody>
          {revisions.map((rev) => <tr key={rev.revision}>
            <td><strong>v{rev.revision}</strong></td>
            <td>{new Date(rev.publishedAt).toLocaleString("zh-CN")}</td>
            <td>{rev.manifest.models.map((m) => m.modelKey).join("、")}</td>
            <td><code title={rev.manifestHash}>{rev.manifestHash.slice(0, 12)}</code></td>
          </tr>)}
        </tbody></table></div> : <div className="mcp-empty">尚未发布。</div>}
        <p className="mcp-caption">历史版本不可修改。部署到 MCP Adapter 仍需独立集成与验证。</p>
      </section>
    </> : <div className="mcp-panel mcp-empty">找不到此 MCP Server。</div>}
  </div>;
}

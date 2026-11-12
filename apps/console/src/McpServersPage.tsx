import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "./mcp-servers.css";

type ModelSelection = { modelKey: string; operations: string[] };
type ResourceSelection = { resourceKey: "person_directory"; operations: string[] };
type Configuration = { models: ModelSelection[]; resources?: ResourceSelection[] };
type Server = {
  id: string; path: string; name: string; description: string;
  enabled: boolean; revision: number; configuration: Configuration;
  createdAt: string; updatedAt: string;
};
type Model = { key: string; version: number; definition: {
  display?: { singular?: string }; access?: string[]; actions?: Record<string, { access?: string }>;
} };
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
const personOps = ["list", "get", "create", "update", "delete"] as const;
const labels: Record<string,string> = {
  list: "查询列表", get: "读取详情", query: "查询", create: "创建",
  update: "更新", delete: "删除",
};
const blank = (): Configuration => ({ models: [], resources: [] });
const path = (id: string) => "/api/mcp-servers/" + encodeURIComponent(id);

async function api<T>(url: string, method: "GET" | "POST" | "PATCH" = "GET",
  data?: unknown, intent?: string): Promise<T> {
  const response = await fetch(url, {
    method, credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(method === "GET" ? {} : { "content-type": "application/json", "x-lifespace-console-intent": intent ?? "" }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }),
  });
  const result = await response.json().catch(() => null) as Envelope<T> | null;
  if (!response.ok) throw new Error(result?.error?.message ?? "请求失败（HTTP " + response.status + "）");
  if (!result || result.data === undefined) throw new Error("服务器响应格式错误");
  return result.data;
}
function allowedOperations(model?: Model) {
  if (!model) return [] as string[];
  const access = model.definition.access ?? [];
  const values: string[] = [];
  if (access.includes("read")) values.push("query", "get");
  if (access.includes("write")) values.push("create", "update", "delete");
  for (const [action, detail] of Object.entries(model.definition.actions ?? {})) {
    if ((detail.access === "read" || detail.access === "write") && access.includes(detail.access)) {
      values.push("action:" + action);
    }
  }
  return values;
}
function validConfiguration(config: Configuration, models: Model[]) {
  if (!config.models.length && !(config.resources?.length ?? 0)) return false;
  if (config.models.length > 32 || (config.resources?.length ?? 0) > 1) return false;
  const byKey = new Map(models.map((model) => [model.key, model]));
  return config.models.every((entry) => {
    const choices = allowedOperations(byKey.get(entry.modelKey));
    return entry.operations.length > 0
      && entry.operations.length <= 32
      && new Set(entry.operations).size === entry.operations.length
      && entry.operations.every((op) => choices.includes(op));
  }) && (config.resources ?? []).every((entry) =>
    entry.resourceKey === "person_directory" && entry.operations.length > 0
    && entry.operations.length <= 5 && new Set(entry.operations).size === entry.operations.length
    && entry.operations.every((op) => personOps.includes(op as typeof personOps[number])));
}
function canonicalConfig(config: Configuration) {
  return JSON.stringify({
    models: config.models.map((model) => ({ modelKey: model.modelKey, operations: [...model.operations].sort() }))
      .sort((a,b) => a.modelKey.localeCompare(b.modelKey)),
    resources: (config.resources ?? []).map((resource) => ({
      resourceKey: resource.resourceKey, operations: [...resource.operations].sort(),
    })),
  });
}
function CapabilityPicker({
  models, config, onChange, disabled,
}: { models: Model[]; config: Configuration; onChange: (config: Configuration) => void; disabled?: boolean }) {
  const [pending, setPending] = useState("");
  const byKey = useMemo(() => new Map(models.map((model) => [model.key, model])), [models]);
  const available = models.filter((model) =>
    !config.models.some((item) => item.modelKey === model.key) && allowedOperations(model).length > 0);
  function add() {
    if (pending === "kernel:person_directory") {
      if (!(config.resources?.length ?? 0)) {
        onChange({ ...config, resources: [{ resourceKey: "person_directory", operations: [] }] });
      }
    } else {
      const model = byKey.get(pending);
      if (model && config.models.length < 32) {
        onChange({ ...config, models: [...config.models, { modelKey: pending, operations: [] }] });
      }
    }
    setPending("");
  }
  function toggle(modelKey: string, operation: string) {
    onChange({ ...config, models: config.models.map((item) => {
      if (item.modelKey !== modelKey) return item;
      const has = item.operations.includes(operation);
      return { ...item, operations: has
        ? item.operations.filter((op) => op !== operation)
        : [...item.operations, operation] };
    }) });
  }
  return <section className="mcp-panel">
    <div className="mcp-panel-head"><h2>开放能力</h2>
      <span>{config.models.length} 个业务模型 · {config.resources?.length ?? 0} 个平台资源</span></div>
    {config.models.map((item) => {
      const model = byKey.get(item.modelKey);
      const selectable = allowedOperations(model);
      const options = Array.from(new Set([...selectable, ...item.operations]));
      return <div className="mcp-model" key={item.modelKey}>
        <div className="mcp-model-head"><div>
          <strong>{model?.definition.display?.singular ?? item.modelKey}</strong>
          <small>业务模型 · {item.modelKey}{model ? " · v" + model.version : " · 当前模型不可用"}</small>
        </div>
        <button type="button" disabled={disabled} className="mcp-text-button"
          onClick={() => onChange({ ...config, models: config.models.filter((m) => m.modelKey !== item.modelKey) })}>移除</button></div>
        <div className="mcp-operations">{options.map((op) => <label key={op} className="mcp-check">
          <input type="checkbox" disabled={disabled || !selectable.includes(op)}
            checked={item.operations.includes(op)} onChange={() => toggle(item.modelKey, op)} />
          {labels[op] ?? "动作 · " + op.replace(/^action:/u,"")}
          {!selectable.includes(op) && <em>已失效</em>}
        </label>)}</div>
        {!item.operations.length && <p className="mcp-inline-help">至少选择一项操作</p>}
      </div>;
    })}
    {(config.resources ?? []).map((resource) => <div className="mcp-model" key={resource.resourceKey}>
      <div className="mcp-model-head"><div>
        <strong>Person · 人员目录</strong>
        <small>平台 Kernel 资源 · person_directory（不同于 Person Profile）</small>
      </div>
      <button type="button" disabled={disabled} className="mcp-text-button"
        onClick={() => onChange({ ...config, resources: [] })}>移除</button></div>
      <div className="mcp-operations">{personOps.map((op) => <label key={op} className="mcp-check">
        <input type="checkbox" disabled={disabled} checked={resource.operations.includes(op)}
          onChange={() => onChange({ ...config, resources: [{ resourceKey: "person_directory",
            operations: resource.operations.includes(op)
              ? resource.operations.filter((value) => value !== op)
              : [...resource.operations, op],
          }] })} />
        {labels[op]}{op === "delete" ? "（仅未关联人员）" : ""}
      </label>)}</div>
      {!resource.operations.length && <p className="mcp-inline-help">至少选择一项人员目录操作</p>}
      <p className="mcp-caption">仅定义可开放的工具；实际调用还须符合独立的 Person Directory Grant、当前 Space Authority 与 Delegation。</p>
    </div>)}
    {!config.models.length && !(config.resources?.length ?? 0) &&
      <div className="mcp-empty mcp-small">选择要开放的业务模型或平台资源。</div>}
    <div className="mcp-add">
      <select aria-label="选择模型或平台资源" value={pending} disabled={disabled}
        onChange={(event) => setPending(event.target.value)}>
        <option value="">选择能力</option>
        <optgroup label="业务模型">
          {available.map((model) => <option value={model.key} key={model.key}>
            {model.definition.display?.singular ?? model.key} · {model.key}
          </option>)}
        </optgroup>
        {!(config.resources?.length ?? 0) && <optgroup label="平台资源">
          <option value="kernel:person_directory">Person · 人员目录</option>
        </optgroup>}
      </select>
      <button type="button" className="secondary-button" onClick={add}
        disabled={disabled || !pending || (pending !== "kernel:person_directory" && config.models.length >= 32)}>
        添加能力</button>
    </div>
  </section>;
}

export default function McpServersPage({ serverKey, navigate }:
  { serverKey?: string; navigate: (route: string) => void }) {
  const [rows, setRows] = useState<Server[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState<Server | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [config, setConfig] = useState<Configuration>(blank());
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [catalog, published] = await Promise.all([
        api<Server[]>("/api/mcp-servers"),
        api<Model[]>("/api/models"),
      ]);
      setRows(catalog);
      setModels(published);
      if (serverKey) {
        const server = await api<Server>(path(serverKey));
        setSelected(server);
        setTitle(server.name);
        setDescription(server.description);
        setConfig({ models: server.configuration.models.map((m) => ({
          modelKey: m.modelKey, operations: [...m.operations],
        })), resources: (server.configuration.resources ?? []).map((r) => ({
          resourceKey: r.resourceKey, operations: [...r.operations],
        })) });
      } else {
        setSelected(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, [serverKey]);
  useEffect(() => {
    setCreating(false);
    setNotice("");
    setError("");
    void load();
  }, [serverKey, load]);

  const dirty = Boolean(selected && (
    selected.name !== title.trim() || selected.description !== description.trim()
    || canonicalConfig(selected.configuration) !== canonicalConfig(config)
  ));
  const valid = validConfiguration(config, models);

  function beginCreate() {
    setCreating(true);
    setSelected(null);
    setTitle("");
    setDescription("");
    setConfig(blank());
    setError("");
    setNotice("");
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError("");
    try {
      const server = await api<Server>("/api/mcp-servers", "POST", {
        name: title.trim(), description: description.trim(), configuration: config,
      }, "create-mcp-server");
      navigate("/mcp-servers/" + encodeURIComponent(server.id));
    } catch (cause) {
      setError("创建结果未确认，请先在列表核对避免重复创建：" +
        (cause instanceof Error ? cause.message : "请求失败"));
    } finally { setBusy(false); }
  }
  async function save() {
    if (!selected || !dirty || busy || !valid) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const server = await api<Server>(path(selected.id), "PATCH", {
        expectedRevision: selected.revision, name: title.trim(),
        description: description.trim(), configuration: config,
      }, "edit-mcp-server");
      setSelected(server);
      setConfig(server.configuration);
      setNotice("配置已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally { setBusy(false); }
  }
  async function changeEnabled() {
    if (!selected || busy || dirty) return;
    const enabled = !selected.enabled;
    if (!window.confirm(enabled ? "启用这个 MCP Server？" : "停用这个 MCP Server？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const server = await api<Server>(path(selected.id), "PATCH", {
        expectedRevision: selected.revision, enabled, confirmId: selected.id,
      }, enabled ? "enable-mcp-server" : "disable-mcp-server");
      setSelected(server);
      setNotice(enabled ? "已启用" : "已停用");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally { setBusy(false); }
  }

  return <div className="mcp-page">
    <header className="mcp-header">
      <div>
        <div className="eyebrow">Platform</div>
        <h1>{serverKey && selected ? selected.name : creating ? "新建 MCP Server" : "MCP Servers"}</h1>
        <p>{serverKey && selected ? "管理开放能力及启用状态" : "管理可直接保存的领域工具配置"}</p>
      </div>
      <div className="mcp-toolbar">
        {serverKey ? <button type="button" className="secondary-button"
          onClick={() => navigate("/mcp-servers")}>返回列表</button>
          : creating ? <button type="button" className="secondary-button" disabled={busy}
              onClick={() => { setCreating(false); setError(""); void load(); }}>取消</button>
          : <button type="button" className="mcp-primary" onClick={beginCreate}>新建 Server</button>}
      </div>
    </header>
    {error && <div className="mcp-message mcp-error" role="alert">{error}</div>}
    {notice && <div className="mcp-message mcp-success" role="status">{notice}</div>}
    {loading ? <div className="mcp-panel mcp-empty">正在加载…</div>
      : !serverKey ? creating ? <form onSubmit={(e) => void create(e)}>
        <section className="mcp-panel">
          <h2>基本信息</h2>
          <div className="mcp-fields">
            <label>名称<input required minLength={2} maxLength={80} value={title}
              onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="例如：日常事务" /></label>
            <label className="mcp-full">描述（可选）<input maxLength={500} value={description}
              onChange={(e) => setDescription(e.target.value)} disabled={busy} /></label>
          </div>
        </section>
        <CapabilityPicker models={models} config={config} onChange={setConfig} disabled={busy} />
        <div className="mcp-actions">
          <button type="submit" className="mcp-primary" disabled={busy || !valid}>创建 Server</button>
        </div>
        <p className="mcp-caption">创建后立即启用配置目录。实际 MCP 协议端点需后续 Adapter 接入，并不自动授予客户端权限。</p>
      </form> : <section className="mcp-panel">
        <div className="mcp-table-scroll"><table className="mcp-table">
          <thead><tr><th>名称</th><th>预定路径</th><th>状态</th><th>管理</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><strong>{row.name}</strong><small>{row.description}</small></td>
            <td><code>{row.path}</code></td>
            <td><span className={"mcp-state " + (row.enabled ? "mcp-published" : "mcp-withdrawn")}>
              {row.enabled ? "已启用" : "已停用"}</span></td>
            <td><button type="button" className="mcp-text-button"
              onClick={() => navigate("/mcp-servers/" + encodeURIComponent(row.id))}>管理</button></td>
          </tr>)}</tbody>
        </table></div>
        {!rows.length && <div className="mcp-empty">尚无 MCP Server。点击右上角新建。</div>}
      </section> : selected ? <>
        <div className="mcp-summary">
          <div><span>状态</span><strong>{selected.enabled ? "已启用" : "已停用"}</strong></div>
          <div><span>资源 ID</span><strong className="mcp-id">{selected.id}</strong></div>
          <div><span>预定 MCP URL 路径</span><strong className="mcp-id">{selected.path}</strong></div>
        </div>
        <section className="mcp-panel">
          <div className="mcp-panel-head"><h2>基本信息</h2><span>Server ID 与路径不可编辑</span></div>
          <div className="mcp-fields">
            <label>名称<input maxLength={80} value={title}
              onChange={(e) => setTitle(e.target.value)} disabled={busy} /></label>
            <label className="mcp-full">描述<input maxLength={500} value={description}
              onChange={(e) => setDescription(e.target.value)} disabled={busy} /></label>
          </div>
        </section>
        <CapabilityPicker models={models} config={config} onChange={setConfig} disabled={busy} />
        <div className="mcp-actions">
          <button type="button" className="mcp-primary" disabled={busy || !dirty || !valid}
            onClick={() => void save()}>保存修改</button>
          <button type="button" className={selected.enabled ? "mcp-danger" : "secondary-button"}
            disabled={busy || dirty} onClick={() => void changeEnabled()}>
            {selected.enabled ? "停用 Server" : "启用 Server"}
          </button>
          {dirty && <span className="mcp-hint">请先保存修改，再操作启用状态</span>}
        </div>
        <p className="mcp-caption">预定地址：https://core.aisr.online{selected.path}。本页仅管理配置；MCP Adapter 尚未接入此动态目录。</p>
      </> : <div className="mcp-panel mcp-empty">找不到此 MCP Server。</div>}
  </div>;
}

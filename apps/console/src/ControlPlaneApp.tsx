import { useEffect, useMemo, useState, type ReactNode } from "react";
import App from "./App";
import "./control-plane.css";

type PublishedModel = {
  id: string;
  key: string;
  route: string;
  version: number;
  state: string;
  schemaHash: string;
  compatibility: string;
  definition: Record<string, unknown>;
  publishedAt: string | null;
};

type ModelAccess = { modelKey: string; maxAccess: "read" | "write" | "manage" };
type ApplicationDetail = {
  application: { id: string; name: string };
  modelAccess: Array<ModelAccess & { applicationId: string }>;
};
type ValidationResult =
  | { valid: true; definition: Record<string, unknown>; schemaHash: string }
  | { valid: false; issues: Array<{ path?: string; code?: string; message?: string }> };

type Dialog =
  | { type: "publish"; modelKey?: string }
  | { type: "retire"; modelKey: string }
  | { type: "model-access"; applicationId: string }
  | null;

type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };
type DataEnvelope<T> = { data: T };

class ControlPlaneError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new ControlPlaneError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);
  }
  if (!payload || !("data" in payload)) throw new ControlPlaneError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");
  return payload.data;
}

async function get<T>(path: string): Promise<T> {
  return readData<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));
}

async function mutate<T>(path: string, method: "POST" | "PUT", intent: string, body: unknown): Promise<T> {
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

function contextFromPath(pathname: string): { page: "models" | "model" | "application" | "other"; id?: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "models" && !parts[1]) return { page: "models" };
  if (parts[0] === "models" && parts[1]) return { page: "model", id: decodePathSegment(parts[1]) };
  if (parts[0] === "applications" && parts[1]) return { page: "application", id: decodePathSegment(parts[1]) };
  return { page: "other" };
}

function DialogShell({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cp-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="cp-dialog-header">
        <div><div className="cp-eyebrow">Control plane</div><h2>{title}</h2><p>{description}</p></div>
        <button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      {children}
    </section>
  </div>;
}

function ErrorNotice({ error }: { error?: unknown }) {
  if (!error) return null;
  const value = error instanceof ControlPlaneError ? error : new ControlPlaneError(error instanceof Error ? error.message : "Unknown error");
  return <div className="cp-notice cp-error"><strong>{value.code ?? "操作失败"}</strong><span>{value.message}</span>{value.requestId && <small>requestId: {value.requestId}</small>}</div>;
}

function SuccessNotice({ children }: { children: ReactNode }) {
  return <div className="cp-notice cp-success">{children}</div>;
}

function PublishDialog({ modelKey, onClose }: { modelKey?: string; onClose: () => void }) {
  const [source, setSource] = useState("{}");
  const [compatibility, setCompatibility] = useState<"initial" | "compatible" | "breaking">(modelKey ? "compatible" : "initial");
  const [loading, setLoading] = useState(Boolean(modelKey));
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<ValidationResult>();
  const [error, setError] = useState<unknown>();
  const [confirmed, setConfirmed] = useState(false);
  const [breakingConfirm, setBreakingConfirm] = useState("");

  useEffect(() => {
    if (!modelKey) return;
    let active = true;
    void get<PublishedModel>(`/api/models/${encodeURIComponent(modelKey)}`).then(
      (model) => {
        if (!active) return;
        setSource(JSON.stringify(model.definition, null, 2));
        setLoading(false);
      },
      (cause) => { if (active) { setError(cause); setLoading(false); } },
    );
    return () => { active = false; };
  }, [modelKey]);

  function parseDefinition(): Record<string, unknown> {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ControlPlaneError("Model Definition 必须是 JSON object", "INVALID_MODEL_DEFINITION");
    return parsed as Record<string, unknown>;
  }

  async function validate() {
    setBusy(true); setError(undefined); setValidation(undefined); setConfirmed(false);
    try {
      const definition = parseDefinition();
      const result = await mutate<ValidationResult>("/api/models/validate", "POST", "validate-model-definition", { definition });
      setValidation(result);
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!validation?.valid || !confirmed) return;
    if (compatibility === "breaking" && breakingConfirm !== "BREAKING") return;
    setBusy(true); setError(undefined);
    try {
      const definition = parseDefinition();
      const confirmModelKey = typeof definition.key === "string" ? definition.key : "";
      if (!confirmModelKey) throw new ControlPlaneError("校验后的 Model Definition 缺少 key", "INVALID_MODEL_DEFINITION");
      const published = await mutate<PublishedModel>("/api/models/publish", "POST", "publish-model-definition", {
        definition,
        compatibility,
        confirmModelKey,
        ...(compatibility === "breaking" ? { breakingConfirmation: breakingConfirm } : {}),
      });
      window.location.assign(`/models/${encodeURIComponent(published.key)}`);
    } catch (cause) { setError(cause); setBusy(false); }
  }

  return <DialogShell title={modelKey ? `发布 ${modelKey} 新版本` : "发布新模型"} description="Model Definition 先经 Core 闭合校验，再以显式 compatibility 发布；发布会原子推进 Registry 与 Model Contract Revision。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading ? <div className="cp-loading">正在读取当前 Model Definition…</div> : <>
        <label className="cp-field"><span>Model Definition JSON</span><textarea className="cp-editor" spellCheck={false} value={source} onChange={(event) => { setSource(event.target.value); setValidation(undefined); setConfirmed(false); }} /></label>
        <div className="cp-row">
          <label className="cp-field cp-compact"><span>Compatibility</span><select value={compatibility} disabled={!modelKey} onChange={(event) => { setCompatibility(event.target.value as typeof compatibility); setBreakingConfirm(""); setConfirmed(false); }}>{!modelKey ? <option value="initial">initial</option> : <><option value="compatible">compatible</option><option value="breaking">breaking</option></>}</select></label>
          <div className="cp-validation-summary">
            {validation?.valid && <SuccessNotice><strong>校验通过</strong><span>schemaHash: {validation.schemaHash}</span></SuccessNotice>}
            {validation && !validation.valid && <div className="cp-notice cp-error"><strong>校验未通过</strong><span>{validation.issues.length} 个问题</span></div>}
          </div>
        </div>
        {validation && !validation.valid && <div className="cp-issues">{validation.issues.map((issue, index) => <div key={`${issue.path ?? "issue"}-${index}`}><code>{issue.path ?? "$"}</code><span>{issue.message ?? issue.code ?? "Validation issue"}</span></div>)}</div>}
        {compatibility === "breaking" && <label className="cp-field"><span>Breaking 变更确认</span><input value={breakingConfirm} onChange={(event) => setBreakingConfirm(event.target.value)} placeholder="输入 BREAKING" /></label>}
        <label className="cp-confirm"><input type="checkbox" checked={confirmed} disabled={!validation?.valid} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认将此定义发布到当前环境；它会改变活动 Registry，并生成新的不可变 Model Contract Revision。</span></label>
        <ErrorNotice error={error} />
      </>}
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>取消</button><button className="cp-secondary" disabled={busy || loading} onClick={() => void validate()}>{busy ? "处理中…" : "Validate"}</button><button className="cp-primary" disabled={busy || loading || !validation?.valid || !confirmed || (compatibility === "breaking" && breakingConfirm !== "BREAKING")} onClick={() => void publish()}>Publish</button></footer>
  </DialogShell>;
}

function RetireDialog({ modelKey, onClose }: { modelKey: string; onClose: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function retire() {
    if (confirm !== modelKey) return;
    setBusy(true); setError(undefined);
    try {
      await mutate<{ modelKey: string; retired: true }>(`/api/models/${encodeURIComponent(modelKey)}/retire`, "POST", "retire-model", { confirmModelKey: modelKey });
      window.location.assign("/models");
    } catch (cause) { setError(cause); setBusy(false); }
  }
  return <DialogShell title={`退役 ${modelKey}`} description="Retire 会从活动 Registry 移除此模型并推进 Model Contract Revision；历史 Definition 与 Contract Revision 不会删除。" onClose={onClose}>
    <div className="cp-dialog-body">
      <div className="cp-danger-box"><strong>这是破坏性控制面操作</strong><span>先确认所有依赖应用和外部系统已停止依赖该模型路由。</span></div>
      <label className="cp-field"><span>输入模型 key 进行确认</span><input value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder={modelKey} /></label>
      <ErrorNotice error={error} />
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>取消</button><button className="cp-danger" disabled={busy || confirm !== modelKey} onClick={() => void retire()}>{busy ? "退役中…" : "Retire model"}</button></footer>
  </DialogShell>;
}

function ModelAccessDialog({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const [application, setApplication] = useState<ApplicationDetail>();
  const [models, setModels] = useState<PublishedModel[]>([]);
  const [access, setAccess] = useState<Record<string, "none" | "read" | "write" | "manage">>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    void Promise.all([
      get<ApplicationDetail>(`/api/applications/${encodeURIComponent(applicationId)}`),
      get<PublishedModel[]>("/api/models"),
    ]).then(([applicationData, modelRows]) => {
      if (!active) return;
      const next: Record<string, "none" | "read" | "write" | "manage"> = {};
      for (const model of modelRows) next[model.key] = "none";
      for (const item of applicationData.modelAccess) next[item.modelKey] = item.maxAccess;
      setApplication(applicationData);
      setModels(modelRows);
      setAccess(next);
      setLoading(false);
    }, (cause) => { if (active) { setError(cause); setLoading(false); } });
    return () => { active = false; };
  }, [applicationId]);

  const changed = useMemo(() => {
    if (!application) return false;
    const before = new Map(application.modelAccess.map((item) => [item.modelKey, item.maxAccess]));
    return models.some((model) => (before.get(model.key) ?? "none") !== (access[model.key] ?? "none"));
  }, [application, models, access]);

  async function save() {
    if (!confirmed || !changed) return;
    setBusy(true); setError(undefined);
    try {
      const selected: ModelAccess[] = models.flatMap((model) => {
        const maxAccess = access[model.key] ?? "none";
        return maxAccess === "none" ? [] : [{ modelKey: model.key, maxAccess }];
      });
      await mutate<{ applicationId: string; models: ModelAccess[] }>(`/api/applications/${encodeURIComponent(applicationId)}/model-access`, "PUT", "replace-application-model-access", {
        models: selected,
        confirmApplicationId: applicationId,
      });
      window.location.reload();
    } catch (cause) { setError(cause); setBusy(false); }
  }

  return <DialogShell title="配置 Application × Model Access" description="这是应用级模型权限上限，不替代 credential scope、Space membership 或 Data Grant。变更在下一次 Core 授权判断中生效。" onClose={onClose}>
    <div className="cp-dialog-body">
      {loading ? <div className="cp-loading">正在读取 Application 与活动 Model Registry…</div> : <>
        <div className="cp-app-summary"><strong>{application?.application.name ?? applicationId}</strong><code>{applicationId}</code></div>
        <div className="cp-access-table">
          <div className="cp-access-head"><span>Model</span><span>Route / version</span><span>Max access</span></div>
          {models.map((model) => <div className="cp-access-row" key={model.key}><div><strong>{model.key}</strong><small>{model.state}</small></div><div><code>/{model.route}</code><small>v{model.version}</small></div><select value={access[model.key] ?? "none"} onChange={(event) => { setAccess((current) => ({ ...current, [model.key]: event.target.value as "none" | "read" | "write" | "manage" })); setConfirmed(false); }}><option value="none">No access</option><option value="read">read</option><option value="write">write</option><option value="manage">manage</option></select></div>)}
        </div>
        {!models.length && <div className="cp-loading">当前没有已发布模型。</div>}
        <label className="cp-confirm"><input type="checkbox" checked={confirmed} disabled={!changed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认原子替换此应用当前的 Model Access catalog；未选择的模型将失去应用级访问权限。</span></label>
        <ErrorNotice error={error} />
      </>}
    </div>
    <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>取消</button><button className="cp-primary" disabled={busy || loading || !changed || !confirmed} onClick={() => void save()}>{busy ? "保存中…" : "Save model access"}</button></footer>
  </DialogShell>;
}

function ControlPlaneLauncher() {
  const pathname = usePathname();
  const context = contextFromPath(pathname);
  const [dialog, setDialog] = useState<Dialog>(null);
  if (context.page === "other") return null;
  return <>
    <div className="cp-launcher" aria-label="控制面写操作">
      <span className="cp-launcher-label">Configure</span>
      {context.page === "models" && <button onClick={() => setDialog({ type: "publish" })}>Publish model</button>}
      {context.page === "model" && context.id && <><button onClick={() => setDialog({ type: "publish", modelKey: context.id })}>Publish version</button><button className="cp-launcher-danger" onClick={() => setDialog({ type: "retire", modelKey: context.id as string })}>Retire</button></>}
      {context.page === "application" && context.id && <button onClick={() => setDialog({ type: "model-access", applicationId: context.id as string })}>Model access</button>}
    </div>
    {dialog?.type === "publish" && <PublishDialog modelKey={dialog.modelKey} onClose={() => setDialog(null)} />}
    {dialog?.type === "retire" && <RetireDialog modelKey={dialog.modelKey} onClose={() => setDialog(null)} />}
    {dialog?.type === "model-access" && <ModelAccessDialog applicationId={dialog.applicationId} onClose={() => setDialog(null)} />}
  </>;
}

export default function ControlPlaneApp() {
  return <><App /><ControlPlaneLauncher /></>;
}

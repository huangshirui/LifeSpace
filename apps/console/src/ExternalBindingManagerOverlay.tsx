import { useEffect, useState } from "react";
import "./external-connections.css";

type Binding = {
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
type Envelope<T> = { data?: T; error?: { code?: string; message?: string; requestId?: string } };

function currentSpaceId(): string | null {
  return /^\/spaces\/(spc_[A-Za-z0-9_-]+)\/?$/u.exec(window.location.pathname)?.[1] ?? null;
}
async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as Envelope<T> | null;
  if (!response.ok || !payload?.data) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload.data;
}
async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));
}
async function mutate<T>(path: string, intent: string, body: Record<string, unknown>): Promise<T> {
  return parse<T>(await fetch(path, {
    method: intent === "refresh-external-model-binding" ? "POST" : "PATCH",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-lifespace-console-intent": intent,
    },
    body: JSON.stringify(body),
  }));
}

export default function ExternalBindingManagerOverlay() {
  const spaceId = currentSpaceId();
  const [open, setOpen] = useState(false);
  if (!spaceId) return null;
  return <>
    <div className="ext-binding-launcher"><button onClick={() => setOpen(true)}>External bindings</button></div>
    {open && <Manager spaceId={spaceId} onClose={() => setOpen(false)} />}
  </>;
}

function Manager({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<Binding[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const result = await get<{ items: Binding[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/external-models`);
      setItems(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }
  useEffect(() => { void load(); }, [spaceId]);

  async function refresh(binding: Binding) {
    setBusy(binding.registrationId); setError("");
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}/refresh`, "refresh-external-model-binding", {});
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "刷新失败"); }
    finally { setBusy(""); }
  }
  async function access(binding: Binding, declaredAccess: "read" | "write") {
    setBusy(binding.registrationId); setError("");
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`, "update-external-model-binding", { declaredAccess });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败"); }
    finally { setBusy(""); }
  }
  async function disable(binding: Binding) {
    if (!window.confirm(`Disable ${binding.displayName}？不会删除 Provider 数据；重新绑定同一资源可恢复。`)) return;
    setBusy(binding.registrationId); setError("");
    try {
      await mutate(`/api/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(binding.modelKey)}`, "update-external-model-binding", { status: "disabled" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停用失败"); }
    finally { setBusy(""); }
  }

  return <div className="ext-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ext-dialog" role="dialog" aria-modal="true" aria-label="External bindings">
      <header><div><small>Space configuration</small><h2>External bindings</h2><p>兜底管理当前 Space 的 External Model bindings。重新启用 disabled binding 请回到 External data 重新绑定同一 Provider Resource。</p></div><button className="ext-close" onClick={onClose}>×</button></header>
      <div className="ext-body">
        {error && <div className="ext-message ext-error"><strong>操作失败</strong><span>{error}</span></div>}
        {!items.length && <div className="ext-empty">当前 Space 还没有 External Model binding。</div>}
        <div className="ext-list">{items.map((binding) => <article className="ext-connection" key={binding.registrationId}>
          <div className="ext-connection-main"><strong>{binding.displayName}</strong><code>{binding.modelKey}</code><div className="ext-badges"><span>{binding.status}</span><span>{binding.declaredAccess}</span><span>{binding.connectionId}</span></div></div>
          <small>Schema observed: {binding.schemaObservedAt || "—"}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small>
          <div className="ext-actions">
            <button disabled={busy === binding.registrationId || binding.status === "disabled"} onClick={() => void refresh(binding)}>Refresh schema</button>
            <button disabled={busy === binding.registrationId || binding.declaredAccess === "read"} onClick={() => void access(binding, "read")}>Set read</button>
            <button disabled={busy === binding.registrationId || binding.declaredAccess === "write"} onClick={() => void access(binding, "write")}>Set write</button>
            <button className="danger" disabled={busy === binding.registrationId || binding.status === "disabled"} onClick={() => void disable(binding)}>Disable</button>
          </div>
        </article>)}</div>
      </div>
    </section>
  </div>;
}

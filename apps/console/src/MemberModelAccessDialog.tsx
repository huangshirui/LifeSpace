import { useEffect, useState } from "react";
import { ConsoleDialog } from "./ConsoleDialog";

type Ceiling = "none" | "read" | "write" | "manage" | null;
type Row = { modelKey: string; displayName: string; available: boolean; ceiling: Ceiling; baseAccess: string[]; boundedAccess: string[] };
type Config = { spaceId: string; userId: string; role: string | null; models: Row[] };
type Member = { userId: string; displayName: string; role: string };
const levels = ["inherit", "none", "read", "write", "manage"] as const;
const labels: Record<string, string> = { inherit: "继承", none: "无权限", read: "只读", write: "读写", manage: "管理" };
const label = (value: string | null) => labels[value ?? "inherit"] ?? "—";
const summary = (access: string[]) => label(access[access.length - 1] ?? "none");
async function read<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...init.headers } });
  const payload = await response.json().catch(() => null) as {data?: T; error?: {message?: string}} | null;
  if (!response.ok || payload?.data === undefined) throw new Error(payload?.error?.message ?? "请求失败（HTTP " + response.status + "）");
  return payload.data;
}

/** Explicit member selection is the launch button. The search filters the read-only
 * list; clicking an individual model opens a separate editor, not an inline form. */
export function MemberModelAccessButton({ spaceId, spaceName, member }: { spaceId: string; spaceName: string; member: Member }) {
  const [open, setOpen] = useState(false);
  return <><button className="link-button" type="button" onClick={() => setOpen(true)}>模型权限</button>
    {open && <MemberModelAccessDialog key={spaceId + ":" + member.userId} spaceId={spaceId} spaceName={spaceName} member={member} onClose={() => setOpen(false)} />}</>;
}

function MemberModelAccessDialog({ spaceId, spaceName, member, onClose }: { spaceId: string; spaceName: string; member: Member; onClose: () => void }) {
  const base = "/api/spaces/" + encodeURIComponent(spaceId) + "/members/" + encodeURIComponent(member.userId) + "/model-access";
  const [config, setConfig] = useState<Config>();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Row>();
  const [value, setValue] = useState<string>("inherit");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(""); setConfig(undefined);
    void read<Config>(base).then(result => { if (current) setConfig(result); })
      .catch(e => { if (current) setError(e instanceof Error ? e.message : "无法读取权限"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [base, revision]);
  const search = query.trim().toLocaleLowerCase();
  const rows = (config?.models ?? []).filter(row => !search || [row.displayName, row.modelKey].some(v => v.toLocaleLowerCase().includes(search)));
  const cancelEditor = () => { if (!busy) { setEditing(undefined); setError(""); } };
  const edit = (row: Row) => { setEditing(row); setValue(row.available ? row.ceiling ?? "inherit" : "inherit"); setError(""); };
  async function save() {
    if (!editing || busy || value === (editing.ceiling ?? "inherit")) return;
    const target = editing;
    setBusy(true); setError("");
    try {
      await read(base + "/" + encodeURIComponent(target.modelKey), {
        method: "POST", headers: { "content-type": "application/json", "x-lifespace-console-intent": "change-member-model-access" },
        body: JSON.stringify({ confirmSpaceId: spaceId, confirmUserId: member.userId, confirmModelKey: target.modelKey, maxAccess: value === "inherit" ? null : value }),
      });
      setEditing(undefined); setLoading(true); setConfig(undefined); setRevision(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "无法保存权限"); }
    finally { setBusy(false); }
  }
  if (editing) return <ConsoleDialog key="edit" title="编辑模型权限" description={spaceName + " · " + member.displayName + " · " + editing.displayName}
    busy={busy} onClose={cancelEditor} footer={<><button type="button" className="secondary-button" disabled={busy} onClick={cancelEditor}>取消</button>
      <button type="submit" form="member-ceiling-form" className="primary-button" disabled={busy || value === (editing.ceiling ?? "inherit")}>{busy ? "保存中…" : "确认保存"}</button></>}>
    <form id="member-ceiling-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p>{editing.modelKey}</p>
      <label className="cp-field"><span>权限上限</span><select value={value} disabled={busy} onChange={event => setValue(event.target.value)}>
        {(editing.available ? levels : ["inherit"]).map(level => <option key={level} value={level}>{label(level)}</option>)}
      </select></label>
      <p>继承表示移除上限，而不是授予新的权限。保存后，已有用户凭证和代表用户的委托也受当前权限约束。</p>
      {error && <div role="alert" className="cp-notice cp-error">{error}</div>}
    </form>
  </ConsoleDialog>;
  return <ConsoleDialog key="list" title="成员模型权限" description={spaceName + " · " + member.displayName + " · " + member.userId}
    onClose={onClose} footer={<button type="button" className="secondary-button" onClick={onClose}>关闭</button>}>
    <p>上限只能收窄已有 Space 权限。下方为 Space 侧预览，应用、凭证和其他规则仍可能进一步限制访问。</p>
    <div className="member-ceiling-search"><input type="search" aria-label="搜索模型" placeholder="搜索模型名称或标识" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} />
      <button type="button" className="secondary-button" disabled={loading} onClick={() => setRevision(n => n + 1)}>刷新</button></div>
    {loading && <p role="status">正在读取权限…</p>}
    {error && <div role="alert" className="cp-notice cp-error">{error}</div>}
    {!loading && config && !rows.length && <p>没有匹配的模型</p>}
    {!loading && config && <div className="member-ceiling-list">{rows.map(row => <div className="member-ceiling-row" key={row.modelKey}>
      <div><strong>{row.displayName}</strong><small>{row.modelKey}{!row.available && " · 当前不可用"}</small></div>
      <div><span>上限：{label(row.ceiling)}</span><small>Space 权限：{summary(row.baseAccess)} → {summary(row.boundedAccess)}</small></div>
      <button type="button" className="secondary-button" disabled={config.role === "owner" || (!row.available && row.ceiling === null)} onClick={() => edit(row)}>编辑</button>
    </div>)}</div>}
  </ConsoleDialog>;
}

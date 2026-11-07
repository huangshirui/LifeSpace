import { useEffect, useState } from "react";
import "./oauth-client-admission.css";

type Policy = {
  cimdEnabled: boolean;
  dcrEnabled: boolean;
  cimdClientIds: string[];
  dcrRedirectUris: string[];
  revision: number;
  updatedAt: string;
};
type Draft = {
  cimdEnabled: boolean; dcrEnabled: boolean;
  cimdClientIds: string; dcrRedirectUris: string;
};
type Envelope = { data?: Policy; error?: { message?: string } };
const list = (value: string) => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
const draftOf = (p: Policy): Draft => ({
  cimdEnabled: p.cimdEnabled, dcrEnabled: p.dcrEnabled,
  cimdClientIds: p.cimdClientIds.join("\n"),
  dcrRedirectUris: p.dcrRedirectUris.join("\n"),
});

export default function OAuthClientAdmissionPage() {
  const [current, setCurrent] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/oauth-client-admission", { credentials: "same-origin", headers: { accept: "application/json" } });
      const json = await res.json() as Envelope;
      if (!res.ok || !json.data) throw new Error(json.error?.message || "无法读取 OAuth 客户端准入策略");
      setCurrent(json.data);
      setDraft(draftOf(json.data));
      setConfirmed(false);
    } catch (err) { setError(err instanceof Error ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  const change = (update: Partial<Draft>) => {
    setDraft(existing => existing ? { ...existing, ...update } : existing);
    setConfirmed(false);
    setNotice("");
  };
  const cid = draft ? list(draft.cimdClientIds) : [];
  const dcr = draft ? list(draft.dcrRedirectUris) : [];
  const changed = current && draft
    ? draft.cimdEnabled !== current.cimdEnabled || draft.dcrEnabled !== current.dcrEnabled
      || JSON.stringify(cid) !== JSON.stringify(current.cimdClientIds)
      || JSON.stringify(dcr) !== JSON.stringify(current.dcrRedirectUris)
    : false;
  const bad = Boolean(draft &&
    ((draft.cimdEnabled && cid.length === 0) || (draft.dcrEnabled && dcr.length === 0)
      || cid.length > 100 || dcr.length > 100
      || new Set(cid).size !== cid.length || new Set(dcr).size !== dcr.length));
  async function save() {
    if (!current || !draft || !changed || bad || !confirmed || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/oauth-client-admission", {
        method: "PUT", credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json",
          "x-lifespace-console-intent": "update-oauth-client-admission" },
        body: JSON.stringify({
          expectedRevision: current.revision,
          cimdEnabled: draft.cimdEnabled, dcrEnabled: draft.dcrEnabled,
          cimdClientIds: cid, dcrRedirectUris: dcr,
        }),
      });
      const json = await res.json() as Envelope;
      if (!res.ok || !json.data) throw new Error(json.error?.message || "保存失败");
      setCurrent(json.data);
      setDraft(draftOf(json.data));
      setConfirmed(false);
      setNotice("已保存。新的客户端准入请求会读取最新规则。");
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  }

  return <div className="oad-page">
    <header className="oad-header">
      <div><div className="oad-eyebrow">Platform / OAuth</div>
        <h1>客户端准入</h1>
        <p>管理第三方 Agent 如何注册 OAuth Client。注册不等于数据授权，Application、Space、Agent 与实际权限仍由 Consent 和 Core 控制。</p></div>
      <button type="button" className="secondary-button" disabled={loading || saving} onClick={() => void refresh()}>刷新</button>
    </header>
    {error && <div className="oad-error" role="alert">{error}</div>}
    {notice && <div className="oad-notice" role="status">{notice}</div>}
    {loading || !draft ? <div className="oad-panel">正在加载准入策略…</div> : <>
      <div className="oad-grid">
        <section className="oad-panel">
          <div className="oad-panel-head">
            <div><h2>CIMD</h2><p>Client ID Metadata Documents · 首选方式</p></div>
            <label className="oad-switch"><input type="checkbox" checked={draft.cimdEnabled}
              onChange={e => change({ cimdEnabled: e.target.checked })} />启用</label>
          </div>
          <label className="oad-label" htmlFor="cimd-urls">允许的客户端元数据 URL</label>
          <textarea id="cimd-urls" spellCheck={false} rows={6} value={draft.cimdClientIds}
            onChange={e => change({ cimdClientIds: e.target.value })}
            placeholder={"https://client.example.com/oauth/client.json\n每行一个完整 HTTPS URL"} />
          <p className="oad-help">仅精确 URL 匹配；请求时重新验证元数据和授权回调。此列表不是客户端身份认证。</p>
        </section>
        <section className="oad-panel">
          <div className="oad-panel-head">
            <div><h2>DCR</h2><p>Dynamic Client Registration · 兼容方式</p></div>
            <label className="oad-switch"><input type="checkbox" checked={draft.dcrEnabled}
              onChange={e => change({ dcrEnabled: e.target.checked })} />启用</label>
          </div>
          <label className="oad-label" htmlFor="dcr-urls">允许注册的精确回调 URL</label>
          <textarea id="dcr-urls" spellCheck={false} rows={6} value={draft.dcrRedirectUris}
            onChange={e => change({ dcrRedirectUris: e.target.value })}
            placeholder={"https://client.example.com/callback\n每行一个完整回调 URL"} />
          <p className="oad-help">DCR 注册前没有 Client ID。这里限制它申报的全部回调地址，不证明客户端属于该服务商。Staging 另有限流和全局注册配额。</p>
        </section>
      </div>
      <section className="oad-footer">
        <div><p>版本 {current?.revision} · {current?.updatedAt ? new Date(current.updatedAt).toLocaleString() : "尚未更新"}</p>
          <p>规则为空时不能启用；修改后立即影响新的客户端注册请求。已有授权需单独撤销。</p></div>
        <div className="oad-save">
          <label className="oad-confirm"><input type="checkbox" checked={confirmed} disabled={!changed || bad || saving}
            onChange={e => setConfirmed(e.target.checked)} />确认更新 OAuth 客户端准入策略</label>
          <button type="button" className="oad-primary" disabled={!changed || bad || !confirmed || saving}
            onClick={() => void save()}>{saving ? "保存中…" : "保存策略"}</button>
        </div>
      </section>
    </>}
  </div>;
}

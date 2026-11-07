import { useEffect, useState } from "react";
import "./oauth-client-admission.css";

type AdmissionMode = "restricted" | "open";
type CallbackMode = "client" | "restricted";
type Policy = {
  cimdEnabled: boolean; dcrEnabled: boolean;
  cimdMode: AdmissionMode; dcrMode: AdmissionMode; callbackMode: CallbackMode;
  cimdClientIds: string[]; dcrRedirectUris: string[]; callbackUris: string[];
  revision: number; updatedAt: string;
};
type Draft = {
  cimdEnabled: boolean; dcrEnabled: boolean;
  cimdMode: AdmissionMode; dcrMode: AdmissionMode; callbackMode: CallbackMode;
  cimdClientIds: string; dcrRedirectUris: string; callbackUris: string;
};
type Envelope = { data?: Policy; error?: { message?: string } };
const lines = (value: string) => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
const asDraft = (p: Policy): Draft => ({
  cimdEnabled: p.cimdEnabled, dcrEnabled: p.dcrEnabled,
  cimdMode: p.cimdMode, dcrMode: p.dcrMode, callbackMode: p.callbackMode,
  cimdClientIds: p.cimdClientIds.join("\n"),
  dcrRedirectUris: p.dcrRedirectUris.join("\n"),
  callbackUris: p.callbackUris.join("\n"),
});
const modes: Array<{ value: AdmissionMode; label: string }> = [
  { value: "open", label: "受保护的自动注册" },
  { value: "restricted", label: "仅指定客户端" },
];

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
      const res = await fetch("/api/oauth-client-admission", {
        credentials: "same-origin", headers: { accept: "application/json" },
      });
      const json = await res.json() as Envelope;
      if (!res.ok || !json.data) throw new Error(json.error?.message || "无法读取 OAuth 客户端准入策略");
      setCurrent(json.data);
      setDraft(asDraft(json.data));
      setConfirmed(false);
    } catch (err) { setError(err instanceof Error ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  const change = (next: Partial<Draft>) => {
    setDraft(prev => prev ? { ...prev, ...next } : prev);
    setConfirmed(false);
    setNotice("");
  };
  const cimd = lines(draft?.cimdClientIds || "");
  const dcr = lines(draft?.dcrRedirectUris || "");
  const callbacks = lines(draft?.callbackUris || "");
  const lists = [cimd, dcr, callbacks];
  const changed = Boolean(current && draft && (
    draft.cimdEnabled !== current.cimdEnabled || draft.dcrEnabled !== current.dcrEnabled
    || draft.cimdMode !== current.cimdMode || draft.dcrMode !== current.dcrMode
    || draft.callbackMode !== current.callbackMode
    || JSON.stringify(cimd) !== JSON.stringify(current.cimdClientIds)
    || JSON.stringify(dcr) !== JSON.stringify(current.dcrRedirectUris)
    || JSON.stringify(callbacks) !== JSON.stringify(current.callbackUris)
  ));
  const invalid = Boolean(draft && (
    lists.some(list => list.length > 100 || new Set(list).size !== list.length)
    || draft.cimdEnabled && draft.cimdMode === "restricted" && cimd.length === 0
    || draft.dcrEnabled && draft.dcrMode === "restricted" && dcr.length === 0
    || draft.callbackMode === "restricted" && callbacks.length === 0
  ));
  async function save() {
    if (!current || !draft || !changed || invalid || !confirmed || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/oauth-client-admission", {
        method: "PUT", credentials: "same-origin",
        headers: {
          accept: "application/json", "content-type": "application/json",
          "x-lifespace-console-intent": "update-oauth-client-admission",
        },
        body: JSON.stringify({
          expectedRevision: current.revision,
          cimdEnabled: draft.cimdEnabled, dcrEnabled: draft.dcrEnabled,
          cimdMode: draft.cimdMode, dcrMode: draft.dcrMode,
          callbackMode: draft.callbackMode,
          cimdClientIds: cimd, dcrRedirectUris: dcr, callbackUris: callbacks,
        }),
      });
      const json = await res.json() as Envelope;
      if (!res.ok || !json.data) throw new Error(json.error?.message || "保存失败");
      setCurrent(json.data); setDraft(asDraft(json.data)); setConfirmed(false);
      setNotice("策略已更新。新注册会读取当前配置；已有授权请到 Account 另行撤销。");
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  }

  return <div className="oad-page">
    <header className="oad-header">
      <div>
        <div className="oad-eyebrow">Platform / OAuth</div>
        <h1>客户端接入策略</h1>
        <p>这里只管理平台如何识别第三方 OAuth Client。应用决定可开放的模型与操作，用户在 Account 自行授权 Application、Space、Agent 和权限。</p>
      </div>
      <button type="button" className="secondary-button" disabled={loading || saving}
        onClick={() => void refresh()}>刷新</button>
    </header>
    {error && <div className="oad-error" role="alert">{error}</div>}
    {notice && <div className="oad-notice" role="status">{notice}</div>}
    {loading || !draft ? <div className="oad-panel">正在加载平台 OAuth 策略…</div> : <>
      <div className="oad-grid">
        <section className="oad-panel">
          <div className="oad-panel-head">
            <div><h2>CIMD</h2><p>客户端元数据发现 · 首选</p></div>
            <label className="oad-switch"><input type="checkbox" checked={draft.cimdEnabled}
              onChange={e => change({ cimdEnabled: e.target.checked })} />启用</label>
          </div>
          <label className="oad-label" htmlFor="cimd-mode">客户端准入</label>
          <select id="cimd-mode" className="oad-select" value={draft.cimdMode}
            onChange={e => change({ cimdMode: e.target.value as AdmissionMode })}>
            {modes.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          {draft.cimdMode === "restricted" ? <>
            <label className="oad-label oad-spaced" htmlFor="cimd-urls">允许的完整客户端元数据 URL</label>
            <textarea id="cimd-urls" spellCheck={false} rows={5} value={draft.cimdClientIds}
              onChange={e => change({ cimdClientIds: e.target.value })}
              placeholder={"https://client.example.com/oauth/client.json\n每行一个完整 HTTPS URL"} />
          </> : <p className="oad-open-note">客户端可通过 HTTPS 元数据 URL 自动发起连接，无需平台管理员逐个添加。仍验证公共地址、元数据、实际回调，并限制远程获取频率和注册总量。客户端身份未经供应商证明。</p>}
          <p className="oad-help">CIMD 的 URL 是客户端元数据文档地址，不是 OAuth 回调 URL。</p>
        </section>
        <section className="oad-panel">
          <div className="oad-panel-head">
            <div><h2>DCR</h2><p>动态客户端注册 · 兼容模式</p></div>
            <label className="oad-switch"><input type="checkbox" checked={draft.dcrEnabled}
              onChange={e => change({ dcrEnabled: e.target.checked })} />启用</label>
          </div>
          <label className="oad-label" htmlFor="dcr-mode">客户端准入</label>
          <select id="dcr-mode" className="oad-select" value={draft.dcrMode}
            onChange={e => change({ dcrMode: e.target.value as AdmissionMode })}>
            {modes.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          {draft.dcrMode === "restricted" ? <>
            <label className="oad-label oad-spaced" htmlFor="dcr-urls">允许注册的完整回调 URL</label>
            <textarea id="dcr-urls" spellCheck={false} rows={5} value={draft.dcrRedirectUris}
              onChange={e => change({ dcrRedirectUris: e.target.value })}
              placeholder={"https://client.example.com/callback\n每行一个完整 URL"} />
          </> : <p className="oad-open-note">无需预先登记每个连接的回调地址。注册时记录客户端提交的精确回调列表；授权时严格匹配。受到注册限流和数据库总量限制，绝不代表已取得用户数据权限。</p>}
          <p className="oad-help">DCR 在注册前没有 Client ID。单个客户端的回调始终要求精确匹配。</p>
        </section>
      </div>
      <section className="oad-panel oad-callbacks">
        <div className="oad-panel-head">
          <div><h2>Allowed callback URLs · 全局额外限制</h2>
            <p>统一作用于 CIMD、DCR 和预注册客户端，不区分客户端协议。</p></div>
        </div>
        <div className="oad-choice">
          <label><input type="radio" name="callback-mode" checked={draft.callbackMode === "client"}
            onChange={() => change({ callbackMode: "client" })} />按各客户端注册的精确回调地址验证（默认）</label>
          <label><input type="radio" name="callback-mode" checked={draft.callbackMode === "restricted"}
            onChange={() => change({ callbackMode: "restricted" })} />额外限制为平台指定的回调 URL</label>
        </div>
        {draft.callbackMode === "restricted" && <>
          <label className="oad-label oad-spaced" htmlFor="callback-urls">平台允许的精确 URL</label>
          <textarea id="callback-urls" spellCheck={false} rows={4} value={draft.callbackUris}
            onChange={e => change({ callbackUris: e.target.value })}
            placeholder="https://example.com/callback" />
        </>}
        <p className="oad-help">不接受通配符。开放自动注册 ≠ 任意跳转：OAuth 授权和 Token 交换仍匹配具体 Client 的回调地址；本机客户端可使用标准 loopback 回调。</p>
      </section>
      <section className="oad-footer">
        <div>
          <p>策略版本 {current?.revision} · {current?.updatedAt ? new Date(current.updatedAt).toLocaleString() : "尚未更新"}</p>
          <p>平台配置不创建用户授权。撤销已有连接请前往 Account；Production 的开放模式仍受部署级安全开关约束。</p>
        </div>
        <div className="oad-save">
          <label className="oad-confirm"><input type="checkbox" checked={confirmed}
            disabled={!changed || invalid || saving} onChange={e => setConfirmed(e.target.checked)} />
            确认保存平台 OAuth 安全策略</label>
          <button type="button" className="oad-primary" disabled={!changed || invalid || !confirmed || saving}
            onClick={() => void save()}>{saving ? "保存中…" : "保存策略"}</button>
        </div>
      </section>
    </>}
  </div>;
}

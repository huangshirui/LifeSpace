import { useEffect, useState } from "react";
import { ConsoleDialog } from "./ConsoleDialog";
import "./oauth-client-admission.css";

type Policy = {
  cimdEnabled: boolean;
  dcrEnabled: boolean;
  callbackUris: string[];
  revision: number;
  updatedAt: string;
};
type Draft = {
  cimdEnabled: boolean;
  dcrEnabled: boolean;
  callbackUrls: string;
};
type Envelope = { data?: Policy; error?: { message?: string } };

const readLines = (value: string) => value.split(/\r?\n/u).map(url => url.trim()).filter(Boolean);
const toDraft = (policy: Policy): Draft => ({
  cimdEnabled: policy.cimdEnabled,
  dcrEnabled: policy.dcrEnabled,
  callbackUrls: policy.callbackUris.join("\n"),
});

export default function OAuthClientAdmissionPage() {
  const [current, setCurrent] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/oauth-client-admission", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const json = await res.json() as Envelope;
      if (!res.ok || !json.data) throw new Error(json.error?.message || "无法读取配置");
      setCurrent(json.data);
      setDraft(toDraft(json.data));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  const update = (patch: Partial<Draft>) => {
    setDraft(previous => previous ? { ...previous, ...patch } : previous);
    setNotice("");
  };
  const urls = readLines(draft?.callbackUrls || "");
  const invalid = urls.length > 100 || new Set(urls).size !== urls.length;
  const changed = Boolean(current && draft && (
    current.cimdEnabled !== draft.cimdEnabled
    || current.dcrEnabled !== draft.dcrEnabled
    || JSON.stringify(current.callbackUris) !== JSON.stringify(urls)
  ));

  async function save() {
    if (!current || !draft || !changed || invalid || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/oauth-client-admission", {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-lifespace-console-intent": "update-oauth-client-admission",
        },
        body: JSON.stringify({
          expectedRevision: current.revision,
          cimdEnabled: draft.cimdEnabled,
          dcrEnabled: draft.dcrEnabled,
          callbackUris: urls,
        }),
      });
      const json = await res.json() as Envelope;
      if (!res.ok || !json.data) throw new Error(json.error?.message || "保存失败");
      setCurrent(json.data);
      setDraft(toDraft(json.data));
      setEditing(false);
      setNotice("已保存。新客户端连接将使用当前配置。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  function beginEdit() { if (current) { setDraft(toDraft(current)); setError(""); setNotice(""); setEditing(true); } }
  function cancelEdit() { if (saving) return; if (current) setDraft(toDraft(current)); setError(""); setEditing(false); }
  return <div className="oad-page">
    <header className="oad-header">
      <div><div className="oad-eyebrow">Platform / OAuth</div><h1>OAuth 客户端</h1><p>设置第三方客户端接入方式。用户数据权限仍由 Account 授权和 Core 控制。</p></div>
      <div className="oad-actions"><button className="secondary-button" type="button" disabled={loading || saving || editing} onClick={() => void reload()}>刷新</button>
        <button className="oad-primary" type="button" disabled={loading || saving || editing || !current} onClick={beginEdit}>编辑</button></div>
    </header>
    {!editing && error && <div className="oad-error" role="alert">{error}</div>}
    {notice && <div className="oad-notice" role="status">{notice}</div>}
    {loading || !current ? <div className="oad-panel">{loading ? "正在加载 OAuth 配置…" : "无法读取配置，请刷新。"}</div> : <>
      <section className="oad-panel"><h2>客户端注册方式</h2>
        <div className="oad-toggle oad-read"><span><strong>CIMD</strong><small>自动发现客户端元数据</small></span><strong>{current.cimdEnabled ? "已启用" : "已停用"}</strong></div>
        <div className="oad-toggle oad-read"><span><strong>DCR</strong><small>允许兼容客户端动态注册</small></span><strong>{current.dcrEnabled ? "已启用" : "已停用"}</strong></div>
      </section>
      <section className="oad-panel"><h2>Allowed callback URLs</h2>
        {current.callbackUris.length ? <ul className="oad-url-list">{current.callbackUris.map(url => <li key={url}><code>{url}</code></li>)}</ul> : <p className="oad-help">未设置额外平台白名单限制（推荐）。</p>}
        <p className="oad-help">OAuth 始终要求回调与当前客户端注册的地址精确匹配；不支持通配符。</p>
      </section>
      <footer className="oad-footer"><small>配置版本 {current.revision}</small></footer>
    </>}
    {editing && draft && <ConsoleDialog title="编辑 OAuth 客户端配置" busy={saving} onClose={cancelEdit} compact
      footer={<><button className="cp-secondary" disabled={saving} onClick={cancelEdit}>取消</button><button className="cp-primary" disabled={!changed || invalid || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存更改"}</button></>}>
      {error && <div className="oad-error" role="alert">{error}</div>}
      <section className="oad-panel oad-editor-panel">
        <h2>客户端注册方式</h2>
        <label className="oad-toggle">
          <span><strong>CIMD</strong><small>自动发现客户端元数据</small></span>
          <input type="checkbox" disabled={saving} checked={draft.cimdEnabled}
            onChange={event => update({ cimdEnabled: event.target.checked })} />
        </label>
        <label className="oad-toggle">
          <span><strong>DCR</strong><small>允许兼容客户端动态注册</small></span>
          <input type="checkbox" disabled={saving} checked={draft.dcrEnabled}
            onChange={event => update({ dcrEnabled: event.target.checked })} />
        </label>
      </section>

      <section className="oad-panel oad-editor-panel">
        <h2>Allowed callback URLs</h2>
        <p className="oad-help">留空表示不增加平台白名单限制（推荐）。需要限制时，每行填一个完整回调 URL。</p>
        <textarea id="allowed-callback-urls" aria-label="Allowed callback URLs"
          disabled={saving} rows={4} spellCheck={false} value={draft.callbackUrls}
          placeholder={"https://client.example.com/oauth/callback"}
          onChange={event => update({ callbackUrls: event.target.value })} />
        <p className="oad-help">无论是否留空，OAuth 始终要求回调与当前客户端注册的地址精确匹配；不支持通配符。</p>
        {invalid && <p className="oad-validation" role="alert">最多 100 条回调地址，不允许重复。</p>}
      </section>

    </ConsoleDialog>}
  </div>;
}

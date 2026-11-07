import { useEffect, useState } from "react";
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
      setNotice("已保存。新客户端连接将使用当前配置。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return <div className="oad-page">
    <header className="oad-header">
      <div>
        <div className="oad-eyebrow">Platform / OAuth</div>
        <h1>OAuth 客户端</h1>
        <p>设置第三方客户端接入方式。用户数据权限仍由 Account 授权和 Core 控制。</p>
      </div>
      <button className="secondary-button" type="button" disabled={loading || saving}
        onClick={() => void reload()}>刷新</button>
    </header>

    {error && <div className="oad-error" role="alert">{error}</div>}
    {notice && <div className="oad-notice" role="status">{notice}</div>}
    {loading || !draft ? <div className="oad-panel">正在加载 OAuth 配置…</div> : <>
      <section className="oad-panel">
        <h2>客户端注册方式</h2>
        <label className="oad-toggle">
          <span><strong>CIMD</strong><small>自动发现客户端元数据</small></span>
          <input type="checkbox" checked={draft.cimdEnabled}
            onChange={event => update({ cimdEnabled: event.target.checked })} />
        </label>
        <label className="oad-toggle">
          <span><strong>DCR</strong><small>允许兼容客户端动态注册</small></span>
          <input type="checkbox" checked={draft.dcrEnabled}
            onChange={event => update({ dcrEnabled: event.target.checked })} />
        </label>
      </section>

      <section className="oad-panel">
        <h2>Allowed callback URLs</h2>
        <p className="oad-help">留空表示不增加平台白名单限制（推荐）。需要限制时，每行填一个完整回调 URL。</p>
        <textarea id="allowed-callback-urls" aria-label="Allowed callback URLs"
          rows={4} spellCheck={false} value={draft.callbackUrls}
          placeholder={"https://client.example.com/oauth/callback"}
          onChange={event => update({ callbackUrls: event.target.value })} />
        <p className="oad-help">无论是否留空，OAuth 始终要求回调与当前客户端注册的地址精确匹配；不支持通配符。</p>
        {invalid && <p className="oad-validation" role="alert">最多 100 条回调地址，不允许重复。</p>}
      </section>

      <footer className="oad-footer">
        <small>配置版本 {current?.revision}</small>
        <button type="button" className="oad-primary"
          disabled={!changed || invalid || saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存更改"}
        </button>
      </footer>
    </>}
  </div>;
}

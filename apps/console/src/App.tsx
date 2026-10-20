import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { consoleApi, ConsoleApiError } from "./api";
import type {
  Application,
  ApplicationDetail,
  AuditEntry,
  ConsoleSession,
  OverviewData,
  PlatformSpace,
  PlatformSpaceDetail,
  PlatformUser,
  PlatformUserDetail,
  PublishedModel,
  SystemData,
} from "./types";

type Route =
  | { page: "overview" }
  | { page: "applications"; id?: string }
  | { page: "models"; id?: string }
  | { page: "users"; id?: string }
  | { page: "spaces"; id?: string }
  | { page: "audit" }
  | { page: "system" };

type Remote<T> = { loading: boolean; data?: T; error?: ConsoleApiError };

const navGroups = [
  { label: "", items: [{ href: "/", label: "Overview", page: "overview" }] },
  {
    label: "Platform",
    items: [
      { href: "/applications", label: "Applications", page: "applications" },
      { href: "/models", label: "Models", page: "models" },
      { href: "/users", label: "Users", page: "users" },
      { href: "/spaces", label: "Spaces", page: "spaces" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/audit", label: "Audit", page: "audit" },
      { href: "/system", label: "System", page: "system" },
    ],
  },
] as const;

function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { page: "overview" };
  if (parts[0] === "applications") return { page: "applications", id: parts[1] };
  if (parts[0] === "models") return { page: "models", id: parts[1] };
  if (parts[0] === "users") return { page: "users", id: parts[1] };
  if (parts[0] === "spaces") return { page: "spaces", id: parts[1] };
  if (parts[0] === "audit") return { page: "audit" };
  if (parts[0] === "system") return { page: "system" };
  return { page: "overview" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return route;
}

function navigate(href: string) {
  if (window.location.pathname === href) return;
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function useRemote<T>(key: string, loader: () => Promise<T>): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ loading: true });
  useEffect(() => {
    let current = true;
    setState({ loading: true });
    void loader().then(
      (data) => current && setState({ loading: false, data }),
      (error: unknown) => current && setState({
        loading: false,
        error: error instanceof ConsoleApiError ? error : new ConsoleApiError(error instanceof Error ? error.message : "Unknown error", 500),
      }),
    );
    return () => { current = false; };
  }, [key]);
  return state;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function Badge({ value, tone }: { value: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
  const resolved = tone ?? (value === "active" || value === "success" || value === "published" ? "good" : value === "pending" ? "warn" : value === "failure" || value === "disabled" || value === "revoked" ? "bad" : "neutral");
  return <span className={`badge badge-${resolved}`}>{value}</span>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="inline-code">{children}</code>;
}

function PageHeader({ title, description, eyebrow, actions }: { title: string; description: string; eyebrow?: string; actions?: ReactNode }) {
  return <div className="page-header">
    <div>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

function Loading() {
  return <div className="state-card"><div className="spinner" /><div><strong>正在读取控制面</strong><p>权限证明与执行凭证只在 Worker 内生成和使用。</p></div></div>;
}

function ErrorState({ error }: { error: ConsoleApiError }) {
  return <div className="state-card state-error">
    <div className="state-icon">!</div>
    <div><strong>{error.code ?? `HTTP ${error.status}`}</strong><p>{error.message}</p>{error.requestId && <small>requestId: {error.requestId}</small>}</div>
  </div>;
}

function Empty({ children = "没有可显示的数据" }: { children?: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="panel"><div className="panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div></div>{children}</section>;
}

function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="kv-grid">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <Empty />;
  return <div className="table-wrap"><table><thead><tr><th>时间</th><th>来源</th><th>操作</th><th>目标</th><th>Actor</th><th>结果</th></tr></thead><tbody>
    {entries.map((entry) => <tr key={`${entry.source}:${entry.id}`}>
      <td className="nowrap">{formatDate(entry.createdAt)}</td>
      <td><Badge value={entry.source} tone="neutral" /></td>
      <td><Code>{entry.operation}</Code></td>
      <td><div>{entry.targetType}</div><small>{entry.targetId}</small></td>
      <td><small>{entry.actorUserId}</small></td>
      <td><Badge value={entry.result} /></td>
    </tr>)}
  </tbody></table></div>;
}

function OverviewPage() {
  const remote = useRemote("overview", consoleApi.overview);
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const data = remote.data as OverviewData;
  return <>
    <PageHeader eyebrow="Platform" title="Overview" description="LifeSpace 平台控制面的当前状态。这里展示治理视图，不展示或编辑业务记录。" />
    <div className="metrics-grid">
      <Metric label="Applications" value={data.counts.applications} hint="已注册应用" />
      <Metric label="Models" value={data.counts.models} hint="Registry definitions" />
      <Metric label="Users" value={`${data.counts.users}${data.counts.usersTruncated ? "+" : ""}`} hint="全局 Identity 用户" />
      <Metric label="Spaces" value={`${data.counts.spaces}${data.counts.spacesTruncated ? "+" : ""}`} hint="所有权边界" />
    </div>
    <div className="two-column">
      <Section title="Identity" description="全局身份与 Web Access principal 映射">
        <KeyValue rows={[
          ["Environment", <Badge value={String(data.identityStatus.environment ?? data.environment)} />],
          ["Schema", String(data.identityStatus.schemaVersion ?? "—")],
          ["Contract", <Code>{String(data.identityStatus.contractVersion ?? "—")}</Code>],
        ]} />
      </Section>
      <Section title="Core" description="Space / Grant / Model Registry / Generic Runtime">
        <KeyValue rows={[
          ["Environment", <Badge value={String(data.coreStatus.environment ?? data.environment)} />],
          ["Schema", String(data.coreStatus.schemaVersion ?? "—")],
          ["Kernel", <Code>{String(data.coreStatus.contractVersion ?? "—")}</Code>],
          ["Registry", <Code>{String(data.coreStatus.registryRevision ?? "—")}</Code>],
        ]} />
      </Section>
    </div>
    <Section title="Recent control-plane activity" description={`快照生成于 ${formatDate(data.generatedAt)}`}>
      <AuditTable entries={data.recentAudit} />
    </Section>
  </>;
}

function ApplicationsPage({ id }: { id?: string }) {
  if (id) return <ApplicationDetailPage id={id} />;
  const remote = useRemote("applications", consoleApi.applications);
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const rows = remote.data ?? [];
  return <>
    <PageHeader eyebrow="Platform" title="Applications" description="查看平台注册应用主体、scope ceiling 与受控后端配置。Application 不表示 Web、Mini Program、PWA、BFF 或部署单元。" />
    <Section title="Registered applications" description="既有语义 Application ID 与平台生成的 app_* ID 都是合法目标。">
      {!rows.length ? <Empty /> : <div className="table-wrap"><table><thead><tr><th>应用</th><th>Trusted backend</th><th>Scopes</th><th>状态</th><th /></tr></thead><tbody>
        {rows.map((app: Application) => <tr key={app.id}>
          <td><strong>{app.name}</strong><small>{app.id}</small></td>
          <td>{app.trustedBackend ? "Yes" : "No"}</td><td>{app.allowedScopes.length}</td><td><Badge value={app.status} /></td>
          <td><button className="link-button" onClick={() => navigate(`/applications/${encodeURIComponent(app.id)}`)}>查看</button></td>
        </tr>)}
      </tbody></table></div>}
    </Section>
  </>;
}

function ApplicationDetailPage({ id }: { id: string }) {
  const remote = useRemote(`application:${id}`, () => consoleApi.application(id));
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const data = remote.data as ApplicationDetail;
  const app = data.application;
  return <>
    <PageHeader eyebrow="Application" title={app.name} description={app.id} actions={<button className="secondary-button" onClick={() => navigate("/applications")}>返回列表</button>} />
    <Section title="Application identity">
      <KeyValue rows={[
        ["ID", <Code>{app.id}</Code>], ["Status", <Badge value={app.status} />],
        ["Trusted backend", app.trustedBackend ? "Yes" : "No"], ["Token TTL", `${app.accessTokenTtlSeconds}s`], ["Updated", formatDate(app.updatedAt)],
      ]} />
      <div className="chip-list">{app.allowedScopes.map((scope) => <span className="chip" key={scope}>{scope}</span>)}</div>
    </Section>
    <div className="two-column">
      <Section title="Application credentials" description="只展示 suffix 和状态；明文与 hash 永不返回 Console 浏览器。多把 lsa_* 代表同一 Application 的凭证生命周期，不代表不同客户端。">
        {!data.credentials.length ? <Empty /> : <div className="stack-list">{data.credentials.map((item) => <div className="stack-row" key={item.id}><div><strong>•••• {item.secretSuffix}</strong><small>{item.id}</small></div><Badge value={item.status} /></div>)}</div>}
      </Section>
      <Section title="Cloudflare Access audiences">
        {!data.accessAudiences.length ? <Empty /> : <div className="stack-list">{data.accessAudiences.map((item) => <div className="stack-row" key={item.id}><div><strong>{item.audience}</strong><small>{item.issuer}</small></div><Badge value={item.status} /></div>)}</div>}
      </Section>
    </div>
    <div className="two-column">
      <Section title="Service principals">
        {!data.servicePrincipals.length ? <Empty /> : <div className="stack-list">{data.servicePrincipals.map((item) => <div className="stack-row" key={item.id}><div><strong>{item.displayName}</strong><small>{item.id} · {item.maxScopes.length} scopes</small></div><Badge value={item.status} /></div>)}</div>}
      </Section>
      <Section title="Application × Model Access">
        {!data.modelAccess.length ? <Empty /> : <div className="stack-list">{data.modelAccess.map((item) => <div className="stack-row" key={item.modelKey}><div><strong>{item.modelKey}</strong><small>actor: {item.createdBy.id}</small></div><Badge value={item.maxAccess} tone="neutral" /></div>)}</div>}
      </Section>
    </div>
  </>;
}

function ModelsPage({ id }: { id?: string }) {
  if (id) return <ModelDetailPage id={id} />;
  const remote = useRemote("models", consoleApi.models);
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const rows = remote.data ?? [];
  return <>
    <PageHeader eyebrow="Platform" title="Models" description="Model Registry 的只读治理视图。发布、退役与兼容性写操作在下一 slice 接入。" />
    <Section title="Registry definitions">
      {!rows.length ? <Empty /> : <div className="table-wrap"><table><thead><tr><th>Model</th><th>Version</th><th>Compatibility</th><th>状态</th><th /></tr></thead><tbody>
        {rows.map((model: PublishedModel) => <tr key={model.id}><td><strong>{model.key}</strong><small>{model.id}</small></td><td>v{model.version}</td><td>{model.compatibility}</td><td><Badge value={model.state} /></td><td><button className="link-button" onClick={() => navigate(`/models/${encodeURIComponent(model.key)}`)}>查看</button></td></tr>)}
      </tbody></table></div>}
    </Section>
  </>;
}

function ModelDetailPage({ id }: { id: string }) {
  const remote = useRemote(`model:${id}`, () => consoleApi.model(id));
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const model = remote.data as PublishedModel;
  return <>
    <PageHeader eyebrow="Model" title={model.key} description={`Registry version ${model.version}`} actions={<button className="secondary-button" onClick={() => navigate("/models")}>返回列表</button>} />
    <Section title="Registry metadata"><KeyValue rows={[
      ["State", <Badge value={model.state} />], ["Compatibility", model.compatibility], ["Schema hash", <Code>{model.schemaHash}</Code>], ["Published", formatDate(model.publishedAt)],
    ]} /></Section>
    <Section title="Canonical definition" description="只读展示当前 Registry Definition。"><pre className="json-view">{JSON.stringify(model.definition, null, 2)}</pre></Section>
  </>;
}

function UsersPage({ id }: { id?: string }) {
  if (id) return <UserDetailPage id={id} />;
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const remote = useRemote(`users:${submitted}`, () => consoleApi.users(submitted ? `?q=${encodeURIComponent(submitted)}&limit=200` : "?limit=200"));
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const rows = remote.data ?? [];
  return <>
    <PageHeader eyebrow="Platform" title="Users" description="全局 LifeSpace Identity 只读检查器。Access 邮箱快照仅用于诊断，不是账号合并依据。" />
    <form className="search-bar" onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 usr_* 或 display name" maxLength={100} /><button>搜索</button></form>
    <Section title="Identity users">
      {!rows.length ? <Empty /> : <div className="table-wrap"><table><thead><tr><th>User</th><th>状态</th><th>创建时间</th><th>更新时间</th><th /></tr></thead><tbody>
        {rows.map((user: PlatformUser) => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.id}</small></td><td><Badge value={user.status} /></td><td>{formatDate(user.createdAt)}</td><td>{formatDate(user.updatedAt)}</td><td><button className="link-button" onClick={() => navigate(`/users/${encodeURIComponent(user.id)}`)}>查看</button></td></tr>)}
      </tbody></table></div>}
    </Section>
  </>;
}

function UserDetailPage({ id }: { id: string }) {
  const remote = useRemote(`user:${id}`, () => consoleApi.user(id));
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const user = remote.data as PlatformUserDetail;
  return <>
    <PageHeader eyebrow="User" title={user.displayName} description={user.id} actions={<button className="secondary-button" onClick={() => navigate("/users")}>返回列表</button>} />
    <Section title="Identity"><KeyValue rows={[["Status", <Badge value={user.status} />], ["Created", formatDate(user.createdAt)], ["Updated", formatDate(user.updatedAt)], ["Avatar", user.avatarUrl ?? "—"]]} /></Section>
    <Section title="Linked Cloudflare Access principals" description="一个 usr_* 可以显式绑定多个 Access (issuer, subject)。">
      {!user.accessPrincipals.length ? <Empty /> : <div className="table-wrap"><table><thead><tr><th>Principal</th><th>Issuer</th><th>Email snapshot</th><th>状态</th><th>Last seen</th></tr></thead><tbody>
        {user.accessPrincipals.map((principal) => <tr key={principal.id}><td><strong>{principal.id}</strong><small>{principal.subject}</small></td><td className="break-word">{principal.issuer}</td><td>{principal.emailSnapshot ?? "—"}</td><td><Badge value={principal.status} /></td><td>{formatDate(principal.lastSeenAt)}</td></tr>)}
      </tbody></table></div>}
    </Section>
  </>;
}

function SpacesPage({ id }: { id?: string }) {
  if (id) return <SpaceDetailPage id={id} />;
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const remote = useRemote(`spaces:${submitted}`, () => consoleApi.spaces(submitted ? `?q=${encodeURIComponent(submitted)}&limit=200` : "?limit=200"));
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const rows = remote.data ?? [];
  return <>
    <PageHeader eyebrow="Platform" title="Spaces" description="只读检查所有权、成员、Data Grant 与模型记录计数；Console 不获得隐藏成员身份。" />
    <form className="search-bar" onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 spc_* 或 Space 名称" maxLength={100} /><button>搜索</button></form>
    <Section title="Spaces">
      {!rows.length ? <Empty /> : <div className="table-wrap"><table><thead><tr><th>Space</th><th>Members</th><th>Grants</th><th>Records</th><th /></tr></thead><tbody>
        {rows.map((space: PlatformSpace) => <tr key={space.id}><td><strong>{space.name}</strong><small>{space.id}</small></td><td>{space.memberCount}</td><td>{space.grantCount}</td><td>{space.recordCount}</td><td><button className="link-button" onClick={() => navigate(`/spaces/${encodeURIComponent(space.id)}`)}>查看</button></td></tr>)}
      </tbody></table></div>}
    </Section>
  </>;
}

function SpaceDetailPage({ id }: { id: string }) {
  const remote = useRemote(`space:${id}`, () => consoleApi.space(id));
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const space = remote.data as PlatformSpaceDetail;
  return <>
    <PageHeader eyebrow="Space" title={space.name} description={space.id} actions={<button className="secondary-button" onClick={() => navigate("/spaces")}>返回列表</button>} />
    <Section title="Ownership boundary"><KeyValue rows={[["Timezone", space.timezone], ["Owner creator", <Code>{space.createdByUserId}</Code>], ["Version", space.version], ["Created", formatDate(space.createdAt)], ["Updated", formatDate(space.updatedAt)]]} /></Section>
    <div className="two-column">
      <Section title={`Members (${space.members.length})`}>{!space.members.length ? <Empty /> : <div className="stack-list">{space.members.map((member) => <div className="stack-row" key={member.id}><div><strong>{member.displayName}</strong><small>{member.userId} · {member.personId}</small></div><Badge value={member.role} tone="neutral" /></div>)}</div>}</Section>
      <Section title="Record counts">{!Object.keys(space.recordCounts).length ? <Empty /> : <div className="stack-list">{Object.entries(space.recordCounts).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => <div className="stack-row" key={key}><strong>{key}</strong><span>{count}</span></div>)}</div>}</Section>
    </div>
    <Section title={`Data Grants (${space.grants.length})`} description="包含已撤销 grant，便于诊断治理历史。">
      {!space.grants.length ? <Empty /> : <div className="table-wrap"><table><thead><tr><th>Grantee</th><th>Resource</th><th>Permission</th><th>Expires</th><th>状态</th></tr></thead><tbody>
        {space.grants.map((grant) => <tr key={grant.id}><td><strong>{grant.granteeType}</strong><small>{grant.granteeId}</small></td><td><strong>{grant.resourceType}</strong><small>{grant.resourceId ?? "all"}</small></td><td>{grant.permission}</td><td>{formatDate(grant.expiresAt)}</td><td><Badge value={grant.revokedAt ? "revoked" : "active"} /></td></tr>)}
      </tbody></table></div>}
    </Section>
  </>;
}

function AuditPage() {
  const remote = useRemote("audit", () => consoleApi.audit(100));
  const entries = useMemo(() => {
    if (!remote.data) return [];
    return [...remote.data.identity, ...remote.data.core].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [remote.data]);
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  return <>
    <PageHeader eyebrow="Operations" title="Audit" description="统一查看 Identity 与 Core 平台控制面操作，始终区分 human actor 与 backend executor。" />
    <Section title="Recent platform-admin events" description="不包含 secret、token hash 或 Authorization header。"><AuditTable entries={entries} /></Section>
  </>;
}

function SystemPage() {
  const remote = useRemote("system", consoleApi.system);
  if (remote.loading) return <Loading />;
  if (remote.error) return <ErrorState error={remote.error} />;
  const data = remote.data as SystemData;
  return <>
    <PageHeader eyebrow="Operations" title="System" description="部署环境、schema、契约和安全边界快照；这里不是 Cloudflare 或数据库控制台。" />
    <div className="two-column">
      <Section title="Console"><KeyValue rows={[["Environment", <Badge value={data.environment} />], ["Version", <Code>{data.consoleVersion}</Code>], ["Identity Admin", <Code>{data.identityAdminApiVersion}</Code>], ["Core Admin", <Code>{data.coreAdminApiVersion}</Code>]]} /></Section>
      <Section title="Security boundary"><KeyValue rows={Object.entries(data.securityBoundary).map(([key, value]) => [key, <Badge key={key} value={value} tone="good" />])} /></Section>
    </div>
    <div className="two-column">
      <Section title="Identity runtime"><pre className="json-view compact">{JSON.stringify(data.identityStatus, null, 2)}</pre></Section>
      <Section title="Core runtime"><pre className="json-view compact">{JSON.stringify(data.coreStatus, null, 2)}</pre></Section>
    </div>
  </>;
}

function RegistrationCard({ onRegistered }: { onRegistered: (session: ConsoleSession) => void }) {
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || !name.trim()) return;
    setBusy(true); setError(undefined);
    try { onRegistered(await consoleApi.registerSession(name.trim())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Registration failed"); }
    finally { setBusy(false); }
  }
  return <div className="login-shell"><div className="onboarding-card">
    <div className="brand-mark large">LS</div><div className="eyebrow">Staging onboarding</div><h1>Access 已通过，但尚未关联 LifeSpace 用户</h1>
    <p>LifeSpace 不会按邮箱自动合并身份。如果这是新的 staging 身份，可以显式创建用户；已有用户应走 proof-backed link flow。</p>
    <form onSubmit={submit}><label>显示名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={50} required /></label><label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我确认要为当前 Access principal 创建新的 staging LifeSpace 用户</label>{error && <div className="form-error">{error}</div>}<button disabled={!confirmed || !name.trim() || busy}>{busy ? "创建中…" : "创建 staging LifeSpace 用户"}</button></form>
  </div></div>;
}

function AppContent({ route }: { route: Route }) {
  if (route.page === "overview") return <OverviewPage />;
  if (route.page === "applications") return <ApplicationsPage id={route.id} />;
  if (route.page === "models") return <ModelsPage id={route.id} />;
  if (route.page === "users") return <UsersPage id={route.id} />;
  if (route.page === "spaces") return <SpacesPage id={route.id} />;
  if (route.page === "audit") return <AuditPage />;
  return <SystemPage />;
}

export default function App() {
  const route = useRoute();
  const [session, setSession] = useState<Remote<ConsoleSession>>({ loading: true });
  useEffect(() => { void consoleApi.session().then((data) => setSession({ loading: false, data }), (error: unknown) => setSession({ loading: false, error: error instanceof ConsoleApiError ? error : new ConsoleApiError("Session failed", 500) })); }, []);

  if (session.loading) return <div className="login-shell"><Loading /></div>;
  if (session.error?.code === "ACCESS_PRINCIPAL_UNLINKED") return <RegistrationCard onRegistered={(data) => setSession({ loading: false, data })} />;
  if (session.error) return <div className="login-shell"><ErrorState error={session.error} /></div>;
  const current = session.data as ConsoleSession;
  const production = current.environment === "production";

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">LS</div><div><strong>LifeSpace</strong><span>Console</span></div></div>
      <nav>{navGroups.map((group, index) => <div className="nav-group" key={`${group.label}-${index}`}>{group.label && <div className="nav-label">{group.label}</div>}{group.items.map((item) => <button key={item.href} className={route.page === item.page ? "nav-item active" : "nav-item"} onClick={() => navigate(item.href)}>{item.label}</button>)}</div>)}</nav>
      <div className="sidebar-footer"><div className="operator"><div className="avatar">{current.user.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{current.user.displayName}</strong><span>{current.user.id}</span></div></div></div>
    </aside>
    <div className="workspace">
      <div className={`environment-banner ${production ? "production" : "staging"}`}><strong>{current.environment.toUpperCase()}</strong><span>{production ? "生产控制面：所有写操作必须明确确认并审计。" : "Staging 控制面：当前 UI slice 为只读浏览。"}</span><span className="version">Console {current.consoleVersion}</span></div>
      <main><AppContent route={route} /></main>
    </div>
  </div>;
}
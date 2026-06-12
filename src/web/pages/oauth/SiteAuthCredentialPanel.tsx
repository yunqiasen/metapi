export default function SiteAuthCredentialPanel() {
  return (
    <div className="card oauth-workbench-card oauth-site-auth-card">
      <div className="oauth-workbench-head">
        <div>
          <div className="oauth-workbench-title">第三方登录凭证</div>
          <div className="oauth-workbench-meta">
            保存 LinuxDO、GitHub、Google 这类用于登录目标站点的身份凭证。
          </div>
        </div>
      </div>

      <div className="oauth-auth-provider-strip" aria-label="计划支持的第三方登录 Provider">
        <span className="oauth-auth-provider-chip">LinuxDO</span>
        <span className="oauth-auth-provider-chip">GitHub</span>
        <span className="oauth-auth-provider-chip">Google</span>
      </div>

      <div className="empty-state oauth-empty-state oauth-site-auth-empty">
        <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 11c1.657 0 3-1.79 3-4s-1.343-4-3-4-3 1.79-3 4 1.343 4 3 4zM5 21a7 7 0 0114 0M18.5 8.5l1.5 1.5 3-3" />
        </svg>
        <div className="empty-state-title">暂无第三方登录凭证</div>
        <div className="empty-state-desc">
          添加 LinuxDO、GitHub 或 Google 凭证后，可在添加 Session 连接时复用。
        </div>
      </div>
    </div>
  );
}

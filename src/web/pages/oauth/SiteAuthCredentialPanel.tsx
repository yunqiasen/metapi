import type {
  SiteAuthCredentialDecryptabilityResponse,
  SiteAuthCredentialInfo,
  SiteAuthCredentialTargetSitesResponse,
  SiteAuthProviderInfo,
} from '../../api.js';

type SiteAuthCredentialPanelProps = {
  providers: SiteAuthProviderInfo[];
  credentials: SiteAuthCredentialInfo[];
  decryptability?: SiteAuthCredentialDecryptabilityResponse | null;
  loaded: boolean;
  onImportCredential: (provider: string) => void;
  onAuthorizeCredential: () => void;
  onVerifyCredential: (credentialId: number) => void;
  onDeleteCredential: (credentialId: number) => void;
  onLoadTargetSites: (credentialId: number) => void;
  verifyingCredentialId?: number | null;
  targetSitesByCredentialId?: Record<number, SiteAuthCredentialTargetSitesResponse | undefined>;
  loadingTargetSitesCredentialId?: number | null;
};

function resolveCredentialTypeLabel(value: string): string {
  if (value === 'cookie') return 'Cookie';
  if (value === 'oauth_token') return 'OAuth Token';
  if (value === 'session_artifact') return '网页登录凭证';
  return 'Manual';
}

function resolveCredentialStatusLabel(value: SiteAuthCredentialInfo['status']): string {
  if (value === 'active') return '有效';
  if (value === 'expired') return '已过期';
  if (value === 'invalid') return '无效';
  return '已禁用';
}

function resolveCredentialIdentity(credential: SiteAuthCredentialInfo): string {
  return credential.email || credential.username || credential.subject || '未识别账号';
}

export default function SiteAuthCredentialPanel({
  providers,
  credentials,
  decryptability = null,
  loaded,
  onImportCredential,
  onAuthorizeCredential,
  onVerifyCredential,
  onDeleteCredential,
  onLoadTargetSites,
  verifyingCredentialId,
  targetSitesByCredentialId = {},
  loadingTargetSitesCredentialId = null,
}: SiteAuthCredentialPanelProps) {
  const visibleProviders = providers.length > 0
    ? providers
    : [
      { provider: 'linuxdo', label: 'LinuxDO', credentialTypes: [], captureModes: [], enabled: true },
      { provider: 'github', label: 'GitHub', credentialTypes: [], captureModes: [], enabled: true },
      { provider: 'google', label: 'Google', credentialTypes: [], captureModes: [], enabled: true },
    ];

  return (
    <div className="card oauth-workbench-card oauth-site-auth-card">
      <div className="oauth-workbench-head">
        <div>
          <div className="oauth-workbench-title">第三方登录凭证</div>
          <div className="oauth-workbench-meta">
            保存 LinuxDO / GitHub / Google 的网页登录凭证，后续连接流程可复用。
          </div>
        </div>
        <div className="oauth-site-auth-import-actions">
          <button type="button" className="btn btn-primary" onClick={onAuthorizeCredential}>
            授权添加凭证
          </button>
          <button type="button" className="btn btn-ghost oauth-outline-button" onClick={() => onImportCredential('linuxdo')}>
            手动导入兜底
          </button>
        </div>
      </div>

      <div className="oauth-auth-provider-strip" aria-label="计划支持的第三方登录 Provider">
        {visibleProviders.map((provider) => (
          <span key={provider.provider} className="oauth-auth-provider-chip">
            {provider.label}
          </span>
        ))}
      </div>

      {decryptability?.failed ? (
        <div className="oauth-page-message oauth-page-message-error oauth-site-auth-health-warning">
          <div className="oauth-page-message-text">
            有 {decryptability.failed} 个第三方登录凭证无法解密，请确认 data/ 与 ACCOUNT_CREDENTIAL_SECRET 来自同一次部署。
          </div>
          <div className="oauth-page-message-meta">
            {decryptability.items
              .filter((item) => !item.ok)
              .map((item) => item.label)
              .join('、')}
          </div>
        </div>
      ) : null}

      {!loaded ? (
        <div className="empty-state oauth-empty-state oauth-site-auth-empty">
          <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
          </svg>
          <div className="empty-state-title">加载中...</div>
          <div className="empty-state-desc">正在加载第三方登录凭证。</div>
        </div>
      ) : credentials.length === 0 ? (
        <div className="empty-state oauth-empty-state oauth-site-auth-empty">
          <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 11c1.657 0 3-1.79 3-4s-1.343-4-3-4-3 1.79-3 4zM5 21a7 7 0 0114 0M18.5 8.5l1.5 1.5 3-3" />
          </svg>
          <div className="empty-state-title">暂无第三方登录凭证</div>
          <div className="empty-state-desc">
            点击“授权添加凭证”，选择 LinuxDO / GitHub / Google 登录后保存。
          </div>
        </div>
      ) : (
        <div className="oauth-site-auth-list">
          {credentials.map((credential) => (
            <div key={credential.id} className="oauth-site-auth-item">
              <div className="oauth-cell-stack">
                <div className="oauth-cell-inline">
                  <div className="oauth-cell-primary">{credential.label}</div>
                  <span className="badge badge-info">{credential.provider}</span>
                  <span className="badge badge-muted">{resolveCredentialTypeLabel(credential.credentialType)}</span>
                </div>
                <div className="oauth-cell-secondary">{resolveCredentialIdentity(credential)}</div>
                {credential.subject ? (
                  <div className="oauth-cell-tertiary">Subject {credential.subject}</div>
                ) : null}
              </div>
              <div className="oauth-site-auth-status">
                <span className={credential.status === 'active' ? 'badge badge-success' : 'badge badge-warning'}>
                  {resolveCredentialStatusLabel(credential.status)}
                </span>
                {credential.expiresAt ? (
                  <span className="oauth-cell-tertiary">过期 {new Date(credential.expiresAt).toLocaleDateString()}</span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-link btn-link-info oauth-site-auth-verify"
                  onClick={() => onVerifyCredential(credential.id)}
                  disabled={verifyingCredentialId === credential.id}
                >
                  {verifyingCredentialId === credential.id ? '验证中...' : '验证'}
                </button>
                <button
                  type="button"
                  className="btn btn-link btn-link-info oauth-site-auth-target-sites"
                  onClick={() => onLoadTargetSites(credential.id)}
                  disabled={loadingTargetSitesCredentialId === credential.id}
                >
                  {loadingTargetSitesCredentialId === credential.id ? '加载中...' : '可用站点'}
                </button>
                <button
                  type="button"
                  className="btn btn-link btn-link-danger oauth-site-auth-delete"
                  onClick={() => onDeleteCredential(credential.id)}
                >
                  删除
                </button>
              </div>
              {targetSitesByCredentialId[credential.id] ? (
                <div className="oauth-site-auth-target-sites-list">
                  {targetSitesByCredentialId[credential.id]?.items.length ? (
                    targetSitesByCredentialId[credential.id]?.items.map((site) => (
                      <div key={site.id} className="oauth-site-auth-target-site">
                        <span className="oauth-cell-primary">{site.name}</span>
                        <span className="badge badge-muted">{site.platform}</span>
                      </div>
                    ))
                  ) : (
                    <div className="oauth-cell-tertiary">暂未发现可复用该凭证登录的站点。</div>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

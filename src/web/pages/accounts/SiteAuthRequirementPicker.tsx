import type {
  SiteAuthCredentialInfo,
  SiteAuthRequirementsResponse,
} from '../../api.js';
import SiteAuthLoginBridge from './SiteAuthLoginBridge.js';
import { useEffect, useMemo, useState } from 'react';

type SiteAuthRequirementPickerProps = {
  data: SiteAuthRequirementsResponse | null;
  loading?: boolean;
  loggingInCredentialId?: number | null;
  startingProvider?: string | null;
  onAddCredential: (provider: string) => void;
  onStartBrowserLogin: (provider: string, credentialId?: number) => void;
  onUseCredential: (credential: SiteAuthCredentialInfo) => void;
  onUseAccountPasswordLogin: () => void;
};

export default function SiteAuthRequirementPicker({
  data,
  loading = false,
  loggingInCredentialId = null,
  startingProvider = null,
  onAddCredential,
  onStartBrowserLogin,
  onUseCredential,
  onUseAccountPasswordLogin,
}: SiteAuthRequirementPickerProps) {
  const requirements = data?.requirements || [];
  const defaultCredentialIds = useMemo(() => {
    const next: Record<string, string> = {};
    for (const requirement of data?.requirements || []) {
      const first = requirement.availableProviderCredentials?.[0];
      if (first) next[requirement.provider] = String(first.id);
    }
    return next;
  }, [data]);
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedCredentialIds(defaultCredentialIds);
  }, [defaultCredentialIds]);

  if (loading) {
    return (
      <div className="site-auth-picker site-auth-picker-loading" data-i18n-skip="true">
        正在识别站点登录方式...
      </div>
    );
  }

  if (!data?.hasThirdPartyLogin || requirements.length === 0) return null;

  const providerLabels = requirements.map((item) => item.label).join(' / ');

  return (
    <div className="site-auth-picker" data-i18n-skip="true">
      <div className="site-auth-picker-header">
        <div>
          <div className="site-auth-picker-title">第三方授权登录</div>
          <div className="site-auth-picker-subtitle">
            检测到该站点支持 {providerLabels} 登录。这里会使用 OAuth 管理里已保存的第三方凭证打开目标站授权登录。
          </div>
        </div>
        <div className="site-auth-picker-toolbar">
          <button
            type="button"
            className="btn btn-ghost site-auth-provider-action"
            onClick={onUseAccountPasswordLogin}
          >
            账号密码登录该站点
          </button>
        </div>
      </div>
      <div className="site-auth-provider-list">
        {requirements.map((requirement) => {
          const targetSiteCredentials = requirement.availableCredentials || [];
          const providerCredentials = requirement.availableProviderCredentials || [];
          const selectedCredentialId = Number.parseInt(selectedCredentialIds[requirement.provider] || '', 10);
          return (
            <div className="site-auth-provider-row" key={requirement.provider}>
              <div className="site-auth-provider-copy">
                <div className="site-auth-provider-name">{requirement.label}</div>
                <div className="site-auth-provider-reason">{requirement.reason}</div>
              </div>
              <div className="site-auth-provider-actions">
                <div className="site-auth-provider-credential-select">
                  <label className="site-auth-provider-select-label">
                    选择已保存 {requirement.label} 凭证
                  </label>
                  {providerCredentials.length > 0 ? (
                    <select
                      value={selectedCredentialIds[requirement.provider] || String(providerCredentials[0]?.id || '')}
                      onChange={(event) => setSelectedCredentialIds((current) => ({
                        ...current,
                        [requirement.provider]: event.target.value,
                      }))}
                    >
                      {providerCredentials.map((credential) => (
                        <option key={credential.id} value={credential.id}>
                          {credential.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="site-auth-provider-empty">
                      没有可用的 {requirement.label} 凭证
                    </div>
                  )}
                </div>
                {providerCredentials.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn-secondary site-auth-provider-action"
                    onClick={() => onStartBrowserLogin(requirement.provider, selectedCredentialId)}
                    disabled={startingProvider === requirement.provider || !selectedCredentialId}
                  >
                    {startingProvider === requirement.provider
                      ? '打开中...'
                      : `使用已保存 ${requirement.label} 登录该站点`}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost site-auth-provider-action"
                    onClick={() => onAddCredential(requirement.provider)}
                  >
                    去 OAuth 管理保存 {requirement.label} 凭证
                  </button>
                )}
                {targetSiteCredentials.map((credential) => (
                  <SiteAuthLoginBridge
                    key={credential.id}
                    credential={credential}
                    loading={loggingInCredentialId === credential.id}
                    onUseCredential={onUseCredential}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

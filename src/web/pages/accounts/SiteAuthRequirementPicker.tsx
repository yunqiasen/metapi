import type {
  SiteAuthCredentialInfo,
  SiteAuthRequirementsResponse,
} from '../../api.js';
import SiteAuthLoginBridge from './SiteAuthLoginBridge.js';

type SiteAuthRequirementPickerProps = {
  data: SiteAuthRequirementsResponse | null;
  loading?: boolean;
  loggingInCredentialId?: number | null;
  startingProvider?: string | null;
  onAddCredential: (provider: string) => void;
  onStartBrowserLogin: (provider: string) => void;
  onUseCredential: (credential: SiteAuthCredentialInfo) => void;
  onOpenBrowserCredentialCapture: () => void;
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
  onOpenBrowserCredentialCapture,
  onUseAccountPasswordLogin,
}: SiteAuthRequirementPickerProps) {
  if (loading) {
    return (
      <div className="site-auth-picker site-auth-picker-loading">
        正在识别站点登录方式...
      </div>
    );
  }

  const requirements = data?.requirements || [];
  if (!data?.hasThirdPartyLogin || requirements.length === 0) return null;

  const providerLabels = requirements.map((item) => item.label).join(' / ');

  return (
    <div className="site-auth-picker">
      <div className="site-auth-picker-header">
        <div>
          <div className="site-auth-picker-title">第三方授权登录</div>
          <div className="site-auth-picker-subtitle">
            检测到该站点支持 {providerLabels} 登录。主流程会打开目标站自己的登录窗口，复用浏览器里已有的 GitHub / Google / LinuxDO 登录态。
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
          <button
            type="button"
            className="btn btn-secondary site-auth-provider-action"
            onClick={onOpenBrowserCredentialCapture}
          >
            自动获取浏览器凭证和 UserID
          </button>
        </div>
      </div>
      <div className="site-auth-provider-list">
        {requirements.map((requirement) => {
          const credentials = requirement.availableCredentials || [];
          return (
            <div className="site-auth-provider-row" key={requirement.provider}>
              <div className="site-auth-provider-copy">
                <div className="site-auth-provider-name">{requirement.label}</div>
                <div className="site-auth-provider-reason">{requirement.reason}</div>
              </div>
              <div className="site-auth-provider-actions">
                <button
                  type="button"
                  className="btn btn-secondary site-auth-provider-action"
                  onClick={() => onStartBrowserLogin(requirement.provider)}
                  disabled={startingProvider === requirement.provider}
                >
                  {startingProvider === requirement.provider
                    ? '打开中...'
                    : `用 ${requirement.label} 浏览器登录该站点`}
                </button>
                {credentials.map((credential) => (
                  <SiteAuthLoginBridge
                    key={credential.id}
                    credential={credential}
                    loading={loggingInCredentialId === credential.id}
                    onUseCredential={onUseCredential}
                  />
                ))}
                {credentials.length === 0 ? (
                  <button
                    type="button"
                    className="btn btn-ghost site-auth-provider-action"
                    onClick={() => onAddCredential(requirement.provider)}
                  >
                    管理已保存 {requirement.label} 凭证
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

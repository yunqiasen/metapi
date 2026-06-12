import type {
  SiteAuthCredentialInfo,
  SiteAuthRequirementsResponse,
} from '../../api.js';
import SiteAuthLoginBridge from './SiteAuthLoginBridge.js';

type SiteAuthRequirementPickerProps = {
  data: SiteAuthRequirementsResponse | null;
  loading?: boolean;
  loggingInCredentialId?: number | null;
  onAddCredential: (provider: string) => void;
  onUseCredential: (credential: SiteAuthCredentialInfo) => void;
};

export default function SiteAuthRequirementPicker({
  data,
  loading = false,
  loggingInCredentialId = null,
  onAddCredential,
  onUseCredential,
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

  return (
    <div className="site-auth-picker">
      <div className="site-auth-picker-title">该站点支持第三方登录</div>
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
                    添加 {requirement.label} 凭证
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

import type { SiteAuthCredentialInfo } from '../../api.js';

type SiteAuthLoginBridgeProps = {
  credential: SiteAuthCredentialInfo;
  loading?: boolean;
  onUseCredential: (credential: SiteAuthCredentialInfo) => void;
};

export default function SiteAuthLoginBridge({
  credential,
  loading = false,
  onUseCredential,
}: SiteAuthLoginBridgeProps) {
  return (
    <button
      type="button"
      className="btn btn-ghost site-auth-provider-action"
      onClick={() => onUseCredential(credential)}
      disabled={loading}
    >
      {loading ? '登录中...' : `使用该凭证登录站点 · ${credential.label}`}
    </button>
  );
}

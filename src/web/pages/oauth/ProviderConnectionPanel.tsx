import type { ReactNode } from 'react';
import ResponsiveBatchActionBar from '../../components/ResponsiveBatchActionBar.js';

type ProviderConnectionPanelProps = {
  connectionCount: number;
  filteredCount: number;
  selectedCount: number;
  isMobile: boolean;
  batchActions: ReactNode;
  children: ReactNode;
};

export default function ProviderConnectionPanel({
  connectionCount,
  filteredCount,
  selectedCount,
  isMobile,
  batchActions,
  children,
}: ProviderConnectionPanelProps) {
  return (
    <div className="card oauth-workbench-card oauth-provider-panel">
      <div className="oauth-workbench-head">
        <div>
          <div className="oauth-workbench-title">Provider 连接列表</div>
          <div className="oauth-workbench-meta">
            已连接 {connectionCount} 个 Provider 账号，当前筛选后显示 {filteredCount} 个。
          </div>
        </div>
      </div>

      {selectedCount > 0 ? (
        <ResponsiveBatchActionBar isMobile={isMobile} info={`已选 ${selectedCount} 项`} desktopStyle={{ marginBottom: 12 }}>
          {batchActions}
        </ResponsiveBatchActionBar>
      ) : null}

      {children}
    </div>
  );
}

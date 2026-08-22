import { useMemo, useState } from 'react';
import { tr } from '../i18n.js';

const CHECK_CX_BASE_URL = 'http://100.126.43.55:3010';

type MonitorTab = 'dashboard' | 'config';

const TABS: Array<{ key: MonitorTab; label: string; path: string; hint: string }> = [
  {
    key: 'dashboard',
    label: '监控面板',
    path: '/',
    hint: '查看站点和模型连通性，手动检测或开启 10 分钟轮询。',
  },
  {
    key: 'config',
    label: '配置站点模型',
    path: '/config',
    hint: '添加站点、API Key、模型列表和检测路由。',
  },
];

export default function Monitors() {
  const [reloadSeed, setReloadSeed] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<MonitorTab>('dashboard');
  const active = TABS.find((item) => item.key === activeTab) ?? TABS[0];
  const frameUrl = useMemo(() => `${CHECK_CX_BASE_URL}${active.path}`, [active.path]);

  const switchTab = (nextTab: MonitorTab) => {
    setLoaded(false);
    setActiveTab(nextTab);
  };

  const reload = () => {
    setLoaded(false);
    setReloadSeed((prev) => prev + 1);
  };

  return (
    <div className="animate-fade-in monitor-page">
      <div className="monitor-toolbar page-header">
        <div>
          <h2 className="page-title">{tr('监控内嵌')}</h2>
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
            Metapi 内嵌本地 check-cx。监控和配置都在这里完成，不用单独打开另一个项目。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={tab.key === activeTab ? 'btn btn-primary' : 'btn btn-ghost'}
                style={tab.key === activeTab ? undefined : { border: '1px solid var(--color-border)' }}
                onClick={() => switchTab(tab.key)}
                aria-pressed={tab.key === activeTab}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{active.hint}</span>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={reload}
            data-tooltip="重新加载当前内嵌页面"
            aria-label="重新加载当前内嵌页面"
          >
            刷新页面
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.open(frameUrl, '_blank', 'noopener,noreferrer')}
            data-tooltip="在新窗口打开当前页面"
            aria-label="在新窗口打开当前页面"
          >
            新窗口打开
          </button>
        </div>
      </div>

      <div className="monitor-frame-shell card">
        {!loaded && (
          <div className="monitor-hint panel-presence">
            正在加载：{frameUrl}
          </div>
        )}
        <iframe
          key={`${activeTab}-${reloadSeed}`}
          src={frameUrl}
          title={`check-cx ${active.label}`}
          className="monitor-iframe"
          onLoad={() => setLoaded(true)}
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}

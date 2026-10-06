import {useEffect, useState} from 'react';
import {FolderOpen} from 'lucide-react';

declare global {
  interface Window {
    tomotaDesktop?: {
      platform: string;
      info: () => Promise<{version: string; workspace: string; logDirectory: string; managedBackend: boolean}>;
      openWorkspace: () => Promise<void>;
      openLogs: () => Promise<void>;
    };
  }
}

export function DesktopBar() {
  const desktop = window.tomotaDesktop;
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {void desktop?.info().then((info) => setWorkspace(info.workspace)).catch(() => {});}, [desktop]);
  if (!desktop) return null;
  return <div className="desktop-bar">
    <div><img src="/tomota-mark.svg" alt=""/><strong>Tomota 工作台</strong><span>DESKTOP</span></div>
    <button title={error || workspace || '打开数据目录'} onClick={() => void desktop.openWorkspace().catch((cause) => setError(String(cause)))}><FolderOpen size={14}/>{error ? '打开失败，请查看日志' : '本地数据'}</button>
  </div>;
}

export const bookViews = ['overview', 'planning', 'workflow', 'workspace', 'fanqie', 'book-settings'] as const;
export type View = typeof bookViews[number] | 'authors' | 'settings';

export function viewFromPath(pathname: string): View {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/authors' || path.startsWith('/authors/')) return 'authors';
  if (path === '/settings') return 'settings';
  const candidate = path.match(/^\/books\/[A-Za-z0-9_-]+\/([^/]+)$/)?.[1] || path.slice(1);
  return bookViews.includes(candidate as typeof bookViews[number]) ? candidate as View : 'overview';
}

export function navigationTarget(view: View, selectedId: string, projectIds: readonly string[]): string {
  if (view === 'authors' || view === 'settings') return `/${view}`;
  const target = projectIds.includes(selectedId) ? selectedId : projectIds[0];
  return target ? `/books/${encodeURIComponent(target)}/${view}` : view === 'overview' ? '/' : `/${view}`;
}

export function needsBook(view: View): boolean {
  return ['planning', 'workflow', 'workspace', 'book-settings'].includes(view);
}

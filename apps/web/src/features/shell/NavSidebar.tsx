import type { MainRoute, Space, Workspace } from '../../types';
import { KnowledgeSidebar } from './KnowledgeSidebar';

/**
 * NavSidebar — the "常用导航" module's left rail.
 *
 * Originally a no-op placeholder that left the NavView (bookmark dashboard) as a
 * full-width "neon island". It now reuses the same real knowledge-base rail so
 * the navigation module is a genuine navigation container: users can browse
 * workspaces / spaces / pages from the left and reach the bookmark dashboard in
 * the content area, consistent with the knowledge-base module.
 */
export function NavSidebar(props: {
  workspace: Workspace | null;
  workspaces: Workspace[];
  space: Space | null;
  spaces: Space[];
  route: MainRoute;
  selectedPageId: string | null;
  onPickWorkspace: (w: Workspace) => void;
  onPickSpace: (s: Space) => void;
  onSelectPage: (id: string) => void;
  onNavigate: (r: MainRoute) => void;
  onNewNote: () => void;
}) {
  return <KnowledgeSidebar {...props} />;
}

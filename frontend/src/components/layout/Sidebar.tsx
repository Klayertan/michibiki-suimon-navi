import { NavLink } from 'react-router-dom'
import { WORKSPACES } from '../../app/workspaces'
import './Sidebar.css'

/**
 * The whole nav model: one workspace switch, no nested menus, no scrolling
 * list of unrelated controls (task section 5's non-goal). react-router-dom's
 * NavLink supplies the "active workspace" highlight, so nothing here
 * duplicates the router's own state -- see docs/FRONTEND_ARCHITECTURE.md's
 * note on why there is no separate `workspace` Zustand store.
 */
export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Workspaces">
      {WORKSPACES.map((workspace) => (
        <NavLink
          key={workspace.id}
          to={workspace.path}
          title={workspace.summary}
          className={({ isActive }) => `sidebar__item${isActive ? ' sidebar__item--active' : ''}`}
        >
          {workspace.label}
        </NavLink>
      ))}
    </nav>
  )
}

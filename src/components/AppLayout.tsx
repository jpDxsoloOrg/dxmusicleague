import { NavLink, Outlet } from "react-router-dom";
import { currentUser } from "../data/mock";
import { Avatar } from "./Avatar";
import "./AppLayout.css";

const NAV = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/rounds", label: "Rounds", icon: "rounds" },
  { to: "/leaderboard", label: "Leaderboard", icon: "leaderboard" },
  { to: "/profile", label: "Profile", icon: "profile" },
];

export function AppLayout() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark grad-text">DX</span>
          <div className="brand-text">
            <strong>DX Music League</strong>
            <span>Premium Edition</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              <span className={`nav-icon nav-icon-${item.icon}`} aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Avatar name={currentUser.displayName} size={36} />
          <div className="me">
            <strong>{currentUser.displayName}</strong>
            <span className="grad-text">PRO PLAN</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="search">
            <span className="search-icon" aria-hidden />
            <input placeholder="Search leagues, players, or tracks…" />
          </div>
          <div className="topbar-right">
            <button className="icon-btn" aria-label="Notifications">
              <span className="bell" aria-hidden />
            </button>
            <Avatar name={currentUser.displayName} size={36} />
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

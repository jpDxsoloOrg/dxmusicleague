import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "./Avatar";
import "./AppLayout.css";

const NAV = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/leagues", label: "Leagues", icon: "leagues" },
  { to: "/rounds", label: "Rounds", icon: "rounds" },
  { to: "/leaderboard", label: "Leaderboard", icon: "leaderboard" },
  { to: "/profile", label: "Profile", icon: "profile" },
  { to: "/help", label: "Help", icon: "help" },
];

export function AppLayout() {
  const { user, signOut } = useAuth();
  const displayName = user?.displayName ?? "Player";

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark grad-text">DX</span>
          <div className="brand-text">
            <strong>Music League</strong>
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
          <Avatar name={displayName} size={36} />
          <div className="me">
            <strong>{displayName}</strong>
            <button type="button" className="sign-out" onClick={() => void signOut()}>
              Sign out
            </button>
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
            <Avatar name={displayName} size={36} />
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

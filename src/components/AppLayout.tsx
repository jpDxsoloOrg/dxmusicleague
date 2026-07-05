import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
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

/* The bottom tab bar on phones shows the five primary destinations;
   Help lives in the avatar menu instead. */
const MOBILE_NAV = NAV.filter((item) => item.to !== "/help");

export function AppLayout() {
  const { user, signOut } = useAuth();
  const displayName = user?.displayName ?? "Player";
  const [menuOpen, setMenuOpen] = useState(false);

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
          <div className="topbar-brand" aria-hidden>
            <span className="brand-mark grad-text">DX</span>
            <strong>Music League</strong>
          </div>
          <div className="search">
            <span className="search-icon" aria-hidden />
            <input placeholder="Search leagues, players, or tracks…" />
          </div>
          <div className="topbar-right">
            <button className="icon-btn" aria-label="Notifications">
              <span className="bell" aria-hidden />
            </button>
            <span className="topbar-avatar">
              <Avatar name={displayName} size={36} />
            </span>
            <div className="menu-wrap">
              <button
                type="button"
                className="avatar-btn"
                aria-label="Account menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Avatar name={displayName} size={36} />
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    className="menu-backdrop"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="mobile-menu" role="menu">
                    <span className="mobile-menu-name">{displayName}</span>
                    <Link to="/help" className="mobile-menu-item" onClick={() => setMenuOpen(false)}>
                      Help
                    </Link>
                    <button
                      type="button"
                      className="mobile-menu-item mobile-menu-signout"
                      onClick={() => void signOut()}
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>

        <nav className="mobile-nav" aria-label="Primary">
          {MOBILE_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `mobile-nav-item${isActive ? " active" : ""}`}
            >
              <span className={`nav-icon nav-icon-${item.icon}`} aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthBrand } from "./AuthBrand";
import "./AuthPage.css";

export function SignInPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string; confirmed?: boolean; email?: string } };
  const redirectTo = location.state?.from ?? "/";

  const [email, setEmail] = useState(location.state?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(
    location.state?.confirmed ? "Email confirmed — sign in to continue." : null,
  );
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand />
        <h1 className="auth-title">Welcome back</h1>
        <p className="auth-subtitle">The league is waiting for your next track.</p>

        <form className="auth-form" onSubmit={onSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="email">Email</label>
            <input
              id="email" className="auth-input" type="email" autoComplete="email"
              placeholder="you@dxleague.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required
            />
          </div>

          <div className="auth-field">
            <div className="auth-field-top">
              <label className="auth-label" htmlFor="password">Password</label>
              <button
                type="button" className="auth-link-sm"
                onClick={() => setInfo("Password reset isn't available yet — reach out to your league host.")}
              >
                Forgot password?
              </button>
            </div>
            <input
              id="password" className="auth-input" type="password" autoComplete="current-password"
              placeholder="••••••••" value={password}
              onChange={(e) => setPassword(e.target.value)} required
            />
          </div>

          {info && !error && <p className="auth-hint">{info}</p>}
          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign In →"}
          </button>
        </form>

        <p className="auth-foot">
          Don't have an account?{" "}
          <Link className="auth-link" to="/signup" state={{ from: redirectTo }}>Create one</Link>
        </p>
      </div>
      <p className="auth-screen-foot">© DX Music League. All tracks reserved.</p>
    </div>
  );
}

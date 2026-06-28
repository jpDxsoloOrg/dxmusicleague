import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthBrand } from "./AuthBrand";
import "./AuthPage.css";

export function SignUpPage() {
  const { signUp, signIn } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const { needsConfirmation } = await signUp({ displayName, email, password });
      if (needsConfirmation) {
        navigate("/confirm", { state: { email, password } });
      } else {
        // Mock backend: account is immediately usable — sign straight in.
        await signIn(email, password);
        navigate("/", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create your account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand />
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-subtitle">Curate. Compete. Conquer.</p>

        <form className="auth-form" onSubmit={onSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="displayName">Display name</label>
            <input
              id="displayName" className="auth-input" type="text" autoComplete="nickname"
              placeholder="What should we call you?" value={displayName}
              onChange={(e) => setDisplayName(e.target.value)} required
            />
          </div>

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
              <button type="button" className="auth-link-sm" onClick={() => setShowPassword((s) => !s)}>
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <input
              id="password" className="auth-input" type={showPassword ? "text" : "password"}
              autoComplete="new-password" placeholder="••••••••" value={password}
              onChange={(e) => setPassword(e.target.value)} required
            />
            <p className="auth-hint">At least 8 characters.</p>
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Creating account…" : "Create Account"}
          </button>
        </form>

        <p className="auth-foot">
          Already have an account?{" "}
          <Link className="auth-link" to="/signin">Sign in</Link>
        </p>
      </div>
      <p className="auth-screen-foot">By joining, you agree to play fair and vote your conscience.</p>
    </div>
  );
}

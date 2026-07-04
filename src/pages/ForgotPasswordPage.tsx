import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthBrand } from "./AuthBrand";
import "./AuthPage.css";

// Two-step password reset: (1) enter email → we send a code; (2) enter the code
// and a new password. Mirrors the Cognito forgot-password flow.
export function ForgotPasswordPage() {
  const { forgotPassword, confirmForgotPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { email?: string } };

  const [step, setStep] = useState<"request" | "reset">("request");
  const [email, setEmail] = useState(location.state?.email ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await forgotPassword(email);
      setInfo("If that email has an account, we sent a reset code to it.");
      setStep("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a reset.");
    } finally {
      setBusy(false);
    }
  }

  async function onReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await confirmForgotPassword(email, code, password);
      navigate("/signin", { replace: true, state: { email, resetDone: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That reset didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand />
        <h1 className="auth-title">Reset your password</h1>
        <p className="auth-subtitle">
          {step === "request"
            ? "Enter your email and we'll send you a reset code."
            : <>Enter the code sent to <strong>{email}</strong> and choose a new password.</>}
        </p>

        {step === "request" ? (
          <form className="auth-form" onSubmit={onRequest}>
            <div className="auth-field">
              <label className="auth-label" htmlFor="email">Email</label>
              <input
                id="email" className="auth-input" type="email" autoComplete="email"
                placeholder="you@dxleague.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus
              />
            </div>

            {info && !error && <p className="auth-hint">{info}</p>}
            {error && <p className="auth-error">{error}</p>}

            <button className="auth-submit" type="submit" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send reset code →"}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={onReset}>
            <div className="auth-field">
              <label className="auth-label" htmlFor="code">Reset code</label>
              <input
                id="code" className="auth-input auth-code" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} placeholder="000000" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus
              />
            </div>
            <div className="auth-field">
              <label className="auth-label" htmlFor="newPassword">New password</label>
              <input
                id="newPassword" className="auth-input" type="password" autoComplete="new-password"
                placeholder="••••••••" value={password}
                onChange={(e) => setPassword(e.target.value)} required
              />
              <p className="auth-hint">At least 8 characters.</p>
            </div>
            <div className="auth-field">
              <label className="auth-label" htmlFor="confirmNew">Confirm new password</label>
              <input
                id="confirmNew" className="auth-input" type="password" autoComplete="new-password"
                placeholder="••••••••" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} required
              />
            </div>

            {info && !error && <p className="auth-hint">{info}</p>}
            {error && <p className="auth-error">{error}</p>}

            <button className="auth-submit" type="submit" disabled={busy || code.length < 6}>
              {busy ? "Resetting…" : "Reset password →"}
            </button>
            <p className="auth-foot" style={{ margin: 0 }}>
              Didn't get a code?{" "}
              <button type="button" className="auth-link" onClick={() => setStep("request")}>Start over</button>
            </p>
          </form>
        )}

        <p className="auth-foot">
          <Link className="auth-link" to="/signin" state={{ email }}>← Back to sign in</Link>
        </p>
      </div>
      <p className="auth-screen-foot">© DX Music League. All tracks reserved.</p>
    </div>
  );
}

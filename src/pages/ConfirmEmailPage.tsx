import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthBrand } from "./AuthBrand";
import "./AuthPage.css";

export function ConfirmEmailPage() {
  const { confirmSignUp, resendCode, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { email?: string; password?: string } };
  const email = location.state?.email;
  const password = location.state?.password;

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reached directly without a pending sign-up — nothing to confirm.
  if (!email) return <Navigate to="/signup" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await confirmSignUp(email!, code);
      // If we still hold the password, sign in straight away; otherwise send to sign-in.
      if (password) {
        await signIn(email!, password);
        navigate("/", { replace: true });
      } else {
        navigate("/signin", { replace: true, state: { confirmed: true, email } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setError(null);
    setInfo(null);
    try {
      await resendCode(email!);
      setInfo("We sent a fresh code to your email.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resend the code.");
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand />
        <div className="auth-badge" aria-hidden>✉️</div>
        <h1 className="auth-title">Verify your email</h1>
        <p className="auth-subtitle">
          We sent a 6-digit code to <strong>{email}</strong>. Enter it below to finish creating your account.
        </p>

        <form className="auth-form" onSubmit={onSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="code">Confirmation code</label>
            <input
              id="code" className="auth-input auth-code" inputMode="numeric" autoComplete="one-time-code"
              maxLength={6} placeholder="000000" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required
            />
          </div>

          {info && !error && <p className="auth-hint">{info}</p>}
          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={busy || code.length < 6}>
            {busy ? "Verifying…" : "Verify & Continue →"}
          </button>
        </form>

        <div className="auth-resend">
          <span className="auth-foot" style={{ margin: 0 }}>
            Didn't get it?{" "}
            <button type="button" className="auth-link" onClick={onResend}>Resend code</button>
          </span>
          <Link className="auth-link-sm" to="/signin">← Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AuthBrand } from "./AuthBrand";
import "./AuthPage.css";

// Every resend spends one message from the pool's daily email quota, so the
// button goes quiet for a minute after each send rather than firing on every click.
const RESEND_COOLDOWN_SECONDS = 60;

export function ConfirmEmailPage() {
  const { confirmSignUp, resendCode, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as {
    state?: { email?: string; password?: string; from?: string; reconfirm?: boolean };
  };
  const email = location.state?.email;
  const password = location.state?.password;
  const redirectTo = location.state?.from ?? "/";
  // Arrived here because an unconfirmed user tried to sign in (vs. a fresh sign-up).
  const reconfirm = location.state?.reconfirm ?? false;

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // In the reconfirm path the sign-up code is likely stale (or never arrived), so
  // send a fresh one automatically on arrival — once.
  const autoSent = useRef(false);
  useEffect(() => {
    if (reconfirm && email && !autoSent.current) {
      autoSent.current = true;
      resendCode(email).then(
        () => {
          setInfo("Your email isn't verified yet — we sent a fresh code.");
          setCooldown(RESEND_COOLDOWN_SECONDS); // the auto-send counts against the quota too
        },
        (err) => setError(err instanceof Error ? err.message : "Couldn't send a new code."),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconfirm, email]);

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

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
        navigate(redirectTo, { replace: true });
      } else {
        navigate("/signin", { replace: true, state: { confirmed: true, email, from: redirectTo } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    if (resending || cooldown > 0) return;
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      await resendCode(email!);
      setInfo("We sent a fresh code to your email.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resend the code.");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand />
        <div className="auth-badge" aria-hidden>✉️</div>
        <h1 className="auth-title">Verify your email</h1>
        <p className="auth-subtitle">
          {reconfirm ? (
            <>Your account still needs verifying. Enter the 6-digit code sent to <strong>{email}</strong> to finish setting it up.</>
          ) : (
            <>We sent a 6-digit code to <strong>{email}</strong>. Enter it below to finish creating your account.</>
          )}
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
            <button
              type="button" className="auth-link" onClick={onResend}
              disabled={resending || cooldown > 0}
            >
              {resending ? "Sending…" : cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </span>
          <Link className="auth-link-sm" to="/signin">← Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

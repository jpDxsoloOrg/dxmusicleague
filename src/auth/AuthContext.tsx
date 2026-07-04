// React context over the AuthBackend. Holds the signed-in user, restores the
// session on load, and exposes the auth actions to pages. Components call
// `useAuth()` and never touch the backend directly.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AuthUser, SignUpInput, SignUpResult } from "./types.ts";
import { auth, isCognitoMode } from "./config.ts";

interface AuthContextValue {
  user: AuthUser | null;
  /** True until the initial session-restore completes (avoids auth-flash). */
  loading: boolean;
  /** Whether the backend needs the email-confirmation step. */
  requiresConfirmation: boolean;
  cognitoMode: boolean;
  signUp(input: SignUpInput): Promise<SignUpResult>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  updateDisplayName(displayName: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    auth
      .currentUser()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  const value: AuthContextValue = {
    user,
    loading,
    requiresConfirmation: auth.requiresConfirmation,
    cognitoMode: isCognitoMode,
    signUp: (input) => auth.signUp(input),
    confirmSignUp: (email, code) => auth.confirmSignUp(email, code),
    resendCode: (email) => auth.resendCode(email),
    forgotPassword: (email) => auth.forgotPassword(email),
    confirmForgotPassword: (email, code, newPassword) => auth.confirmForgotPassword(email, code, newPassword),
    signIn: async (email, password) => {
      setUser(await auth.signIn(email, password));
    },
    signOut: async () => {
      await auth.signOut();
      setUser(null);
    },
    updateDisplayName: async (displayName) => {
      setUser(await auth.updateDisplayName(displayName));
    },
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

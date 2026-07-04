// MockAuth — the local-dev / no-AWS auth backend. Mirrors the backend's
// MemoryRepository: instant, offline, seeded with the same "current user"
// (u-me / Curator Max) the mock data store uses. Sign-up/confirm are no-ops so
// the whole flow is clickable, and the session persists in localStorage across
// reloads. Selected automatically when no Cognito config is present.

import type { AuthBackend, AuthUser, SignUpInput, SignUpResult } from "./types.ts";
import { AuthError, UNCONFIRMED_USER } from "./types.ts";

const STORAGE_KEY = "dxml.mockAuth.user";
const PENDING_KEY = "dxml.mockAuth.unconfirmed"; // emails awaiting verification

// The seed identity the mock data store (src/data/mock.ts) treats as "me".
const SEED_USER: AuthUser = { id: "u-me", displayName: "Curator Max", email: "you@dxleague.dev" };

// Test affordance: any email containing "unconfirmed" simulates the Cognito
// needs-verification flow (sign-up leaves it pending; sign-in throws
// UserNotConfirmedException until confirmed), so the confirm + reconfirm screens
// are exercisable locally with no AWS. Every other email confirms instantly.
function simulatesUnconfirmed(email: string): boolean {
  return email.toLowerCase().includes("unconfirmed");
}
function pendingEmails(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function savePending(set: Set<string>): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify([...set]));
}

export class MockAuth implements AuthBackend {
  readonly requiresConfirmation = false;

  async currentUser(): Promise<AuthUser | null> {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  }

  async idToken(): Promise<string | null> {
    // No real token locally; the local API server authenticates via a dev header.
    const user = await this.currentUser();
    return user ? `mock.${user.id}` : null;
  }

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    if (!input.email.trim() || !input.password) throw new AuthError("Email and password are required.");
    const email = input.email.trim();
    if (simulatesUnconfirmed(email)) {
      // Leave it pending confirmation; don't sign in yet.
      const pending = pendingEmails();
      pending.add(email.toLowerCase());
      savePending(pending);
      return { needsConfirmation: true };
    }
    // Pretend the account was created as the seed user; no confirmation needed.
    this.persist({ ...SEED_USER, displayName: input.displayName.trim() || SEED_USER.displayName, email });
    return { needsConfirmation: false };
  }

  async confirmSignUp(email: string): Promise<void> {
    // Any code works in the mock — just mark the account verified.
    const pending = pendingEmails();
    pending.delete(email.trim().toLowerCase());
    savePending(pending);
  }

  async resendCode(): Promise<void> {
    /* no-op: nothing to email in the mock */
  }

  async forgotPassword(email: string): Promise<void> {
    if (!email.trim()) throw new AuthError("Enter your email to reset your password.");
    /* no-op: pretend a reset code was emailed */
  }

  async confirmForgotPassword(_email: string, code: string, newPassword: string): Promise<void> {
    if (!code.trim()) throw new AuthError("Enter the reset code from your email.");
    if (newPassword.length < 8) throw new AuthError("Password must be at least 8 characters.");
    /* no-op: mock has no password store — any code resets successfully */
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    if (!email.trim() || !password) throw new AuthError("Enter your email and password.");
    const trimmed = email.trim();
    if (pendingEmails().has(trimmed.toLowerCase())) {
      throw new AuthError("Please confirm your email to continue.", UNCONFIRMED_USER);
    }
    const user: AuthUser = { ...SEED_USER, email: trimmed };
    this.persist(user);
    return user;
  }

  async signOut(): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
  }

  private persist(user: AuthUser): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  }
}

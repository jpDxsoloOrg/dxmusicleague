// MockAuth — the local-dev / no-AWS auth backend. Mirrors the backend's
// MemoryRepository: instant, offline, seeded with the same "current user"
// (u-me / Curator Max) the mock data store uses. Sign-up/confirm are no-ops so
// the whole flow is clickable, and the session persists in localStorage across
// reloads. Selected automatically when no Cognito config is present.

import type { AuthBackend, AuthUser, SignUpInput, SignUpResult } from "./types.ts";
import { AuthError } from "./types.ts";

const STORAGE_KEY = "dxml.mockAuth.user";

// The seed identity the mock data store (src/data/mock.ts) treats as "me".
const SEED_USER: AuthUser = { id: "u-me", displayName: "Curator Max", email: "you@dxleague.dev" };

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
    // Pretend the account was created as the seed user; no confirmation needed.
    this.persist({ ...SEED_USER, displayName: input.displayName.trim() || SEED_USER.displayName, email: input.email.trim() });
    return { needsConfirmation: false };
  }

  async confirmSignUp(): Promise<void> {
    /* no-op: mock never requires confirmation */
  }

  async resendCode(): Promise<void> {
    /* no-op */
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    if (!email.trim() || !password) throw new AuthError("Enter your email and password.");
    const user: AuthUser = { ...SEED_USER, email: email.trim() };
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

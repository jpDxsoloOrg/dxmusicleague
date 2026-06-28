// Auth abstraction — same idea as the music-provider and backend Repository
// seams: the app talks to an `AuthBackend` interface, never to Cognito directly.
// Two implementations exist (auth/cognito.ts, auth/mock.ts) chosen by config,
// so the app runs fully locally on mock auth and against real Cognito on AWS.

/** The signed-in user, normalized across auth backends. `id` is the stable
 *  identifier the API uses as the caller (Cognito `sub`, or a seed id locally). */
export interface AuthUser {
  id: string;
  displayName: string;
  email: string;
}

/** Result of a sign-up: Cognito may require email confirmation before sign-in. */
export interface SignUpResult {
  /** True when a confirmation code must be entered before the account is usable. */
  needsConfirmation: boolean;
}

export interface SignUpInput {
  displayName: string;
  email: string;
  password: string;
}

export interface AuthBackend {
  /** True if this backend needs the email-confirmation step (Cognito does). */
  readonly requiresConfirmation: boolean;

  /** Restore a persisted session on app load, or null if not signed in. */
  currentUser(): Promise<AuthUser | null>;

  /** The bearer token to send on API requests (JWT for Cognito), or null. */
  idToken(): Promise<string | null>;

  signUp(input: SignUpInput): Promise<SignUpResult>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;

  signIn(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;
}

/** Thrown by backends with a user-facing message the pages render verbatim. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

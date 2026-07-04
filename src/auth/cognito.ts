// CognitoAuth — the real auth backend, wrapping amazon-cognito-identity-js
// (pure browser SRP, no Amplify). Talks to the Cognito user pool the CDK stack
// provisions. Mirrors the backend's DynamoRepository: same AuthBackend port as
// MockAuth, swapped in when Cognito env config is present.

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
  type CognitoUserSession,
  type ISignUpResult,
} from "amazon-cognito-identity-js";
import type { AuthBackend, AuthUser, SignUpInput, SignUpResult } from "./types.ts";
import { AuthError } from "./types.ts";

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
}

export class CognitoAuth implements AuthBackend {
  readonly requiresConfirmation = true;
  private pool: CognitoUserPool;

  constructor(config: CognitoConfig) {
    this.pool = new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.clientId });
  }

  private user(email: string): CognitoUser {
    return new CognitoUser({ Username: email, Pool: this.pool });
  }

  async currentUser(): Promise<AuthUser | null> {
    const cognitoUser = this.pool.getCurrentUser();
    if (!cognitoUser) return null;
    const session = await this.session(cognitoUser).catch(() => null);
    if (!session || !session.isValid()) return null;
    return userFromSession(session);
  }

  async idToken(): Promise<string | null> {
    const cognitoUser = this.pool.getCurrentUser();
    if (!cognitoUser) return null;
    const session = await this.session(cognitoUser).catch(() => null);
    if (!session || !session.isValid()) return null;
    return session.getIdToken().getJwtToken();
  }

  signUp(input: SignUpInput): Promise<SignUpResult> {
    const attributes = [
      new CognitoUserAttribute({ Name: "email", Value: input.email.trim() }),
      new CognitoUserAttribute({ Name: "name", Value: input.displayName.trim() }),
    ];
    return new Promise((resolve, reject) => {
      this.pool.signUp(input.email.trim(), input.password, attributes, [], (err, result?: ISignUpResult) => {
        if (err) return reject(toAuthError(err));
        resolve({ needsConfirmation: !result?.userConfirmed });
      });
    });
  }

  confirmSignUp(email: string, code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.user(email).confirmRegistration(code.trim(), true, (err) => {
        if (err) return reject(toAuthError(err));
        resolve();
      });
    });
  }

  resendCode(email: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.user(email).resendConfirmationCode((err) => {
        if (err) return reject(toAuthError(err));
        resolve();
      });
    });
  }

  forgotPassword(email: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.user(email).forgotPassword({
        onSuccess: () => resolve(),
        onFailure: (err) => reject(toAuthError(err)),
      });
    });
  }

  confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.user(email).confirmPassword(code.trim(), newPassword, {
        onSuccess: () => resolve(),
        onFailure: (err) => reject(toAuthError(err)),
      });
    });
  }

  signIn(email: string, password: string): Promise<AuthUser> {
    const cognitoUser = this.user(email);
    const details = new AuthenticationDetails({ Username: email.trim(), Password: password });
    return new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(details, {
        onSuccess: (session) => resolve(userFromSession(session)),
        onFailure: (err) => reject(toAuthError(err)),
      });
    });
  }

  async signOut(): Promise<void> {
    this.pool.getCurrentUser()?.signOut();
  }

  private session(cognitoUser: CognitoUser): Promise<CognitoUserSession> {
    return new Promise((resolve, reject) => {
      cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session) return reject(err ?? new Error("No session"));
        resolve(session);
      });
    });
  }
}

/** Build our normalized AuthUser from a Cognito session's ID-token claims. */
function userFromSession(session: CognitoUserSession): AuthUser {
  const claims = session.getIdToken().decodePayload() as Record<string, string>;
  return {
    id: claims.sub,
    email: claims.email ?? "",
    displayName: claims.name || claims.preferred_username || claims.email || "Player",
  };
}

/** Surface Cognito's message + error code as a clean AuthError the pages render.
 *  The SDK puts the exception name on `.code` (older) or `.name` (newer). */
function toAuthError(err: unknown): AuthError {
  const e = err as { message?: string; code?: string; name?: string };
  const message = e?.message ?? "Something went wrong. Please try again.";
  return new AuthError(message, e?.code ?? e?.name);
}

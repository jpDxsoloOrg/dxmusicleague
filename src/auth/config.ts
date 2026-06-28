// Picks the auth backend from Vite env, the same way the app will pick its data
// source. If Cognito vars are set (AWS mode) → real CognitoAuth; otherwise →
// MockAuth (local development, no AWS). One singleton `auth` for the whole app.
//
// To run against the deployed pool, create web/.env.local with:
//   VITE_COGNITO_USER_POOL_ID=us-east-1_BmxDHFhef
//   VITE_COGNITO_CLIENT_ID=4fldkrmdloui2fgg8lmlqisr38
//   VITE_API_URL=https://uncjl7aiph.execute-api.us-east-1.amazonaws.com/prod
// Leave them unset for the fully-mocked local experience.

import type { AuthBackend } from "./types.ts";
import { MockAuth } from "./mock.ts";
import { CognitoAuth } from "./cognito.ts";

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;

/** True when the app is wired to real AWS Cognito rather than the mock backend. */
export const isCognitoMode = Boolean(userPoolId && clientId);

export const auth: AuthBackend = isCognitoMode
  ? new CognitoAuth({ userPoolId: userPoolId!, clientId: clientId! })
  : new MockAuth();

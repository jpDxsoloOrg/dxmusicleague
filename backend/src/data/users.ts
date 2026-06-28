// Production UserDirectory backed by Cognito. Display names are resolved from
// the user pool by `sub`. Results are memoized per cold start since names rarely
// change within a request lifetime. The league loop only needs display names;
// richer profile data can be added later.

import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { UserDirectory } from "./repository.ts";

export class CognitoUserDirectory implements UserDirectory {
  private cache = new Map<string, string>();
  private client: CognitoIdentityProviderClient;
  private poolId: string;

  constructor(poolId = process.env.USER_POOL_ID ?? "", client = new CognitoIdentityProviderClient({})) {
    this.poolId = poolId;
    this.client = client;
  }

  async getDisplayName(userId: string): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    if (!this.poolId) return userId;

    try {
      // `sub` isn't the username, so look the user up by the sub attribute.
      const res = await this.client.send(
        new ListUsersCommand({ UserPoolId: this.poolId, Filter: `sub = "${userId}"`, Limit: 1 }),
      );
      const attrs = res.Users?.[0]?.Attributes ?? [];
      const name =
        attrs.find((a) => a.Name === "preferred_username")?.Value ??
        attrs.find((a) => a.Name === "name")?.Value ??
        attrs.find((a) => a.Name === "email")?.Value ??
        userId;
      this.cache.set(userId, name);
      return name;
    } catch (err) {
      console.error(`Failed to resolve display name for ${userId}:`, err);
      return userId;
    }
  }
}

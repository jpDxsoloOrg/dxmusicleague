#!/usr/bin/env node
// CDK app entry point. `cdk deploy` (or `npm run synth`) starts here.
import { App } from "aws-cdk-lib";
import { MusicLeagueStack } from "./stack.ts";

const app = new App();

// SES sender for the user pool's outbound mail — see "Email delivery" in
// ../README.md. Pass it at deploy time once the identity is verified:
//   npx cdk deploy -c sesFromEmail=no-reply@dxleague.com
// (or export SES_FROM_EMAIL). Leave it unset and the pool keeps Cognito's
// built-in sender, which is capped at 50 messages/day.
const setting = (contextKey: string, envVar: string): string | undefined =>
  (app.node.tryGetContext(contextKey) as string | undefined) ?? process.env[envVar];

new MusicLeagueStack(app, "MusicLeagueStack", {
  env: { region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  sesFromEmail: setting("sesFromEmail", "SES_FROM_EMAIL"),
  sesFromName: setting("sesFromName", "SES_FROM_NAME"),
  sesVerifiedDomain: setting("sesVerifiedDomain", "SES_VERIFIED_DOMAIN"),
  sesRegion: setting("sesRegion", "SES_REGION"),
});

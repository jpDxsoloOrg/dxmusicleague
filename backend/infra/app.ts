#!/usr/bin/env node
// CDK app entry point. `cdk deploy` (or `npm run synth`) starts here.
import { App } from "aws-cdk-lib";
import { MusicLeagueStack } from "./stack.ts";

const app = new App();
new MusicLeagueStack(app, "MusicLeagueStack", {
  env: { region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});

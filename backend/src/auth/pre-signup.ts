// PreSignUp trigger — TEMPORARY stopgap while the SES migration is pending.
//
// Cognito's built-in email sender is capped at 50 messages/day for the whole
// AWS account, and the quota is currently exhausted by sign-up traffic, so
// verification codes stop arriving and registration dies. Auto-confirming
// here means sign-up sends no email at all: the user lands in the app
// immediately, and the shared quota is left for password resets.
//
// autoVerifyEmail marks the address verified without proof so "forgot
// password" still has a channel it is willing to send to. The cost is that a
// typo'd address gets trusted — accepted short-term.
//
// Remove this trigger (and its wiring in ../../infra/stack.ts) once the user
// pool sends through our verified SES identity; real verification resumes.
import type { PreSignUpTriggerHandler } from "aws-lambda";

export const handler: PreSignUpTriggerHandler = async (event) => {
  event.response.autoConfirmUser = true;
  if (event.request.userAttributes["email"]) {
    event.response.autoVerifyEmail = true;
  }
  return event;
};

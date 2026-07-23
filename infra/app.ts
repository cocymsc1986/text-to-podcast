#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { TextToPodcastStack } from "./stack.js";

const app = new App();

new TextToPodcastStack(app, "TextToPodcast", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // Secrets/config sourced from the deploy environment (see README).
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  appSecret: process.env.APP_SECRET ?? "",
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  defaultVoice: process.env.DEFAULT_VOICE ?? "Matthew",
  pollRateMinutes: Number(process.env.POLL_RATE_MINUTES ?? "15"),
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (needed at deploy time)`);
  return v;
}

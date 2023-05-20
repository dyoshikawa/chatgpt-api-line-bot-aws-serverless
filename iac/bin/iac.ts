#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ChatGptLineBotSampleStack } from "../lib/chat-gpt-line-bot-sample-stack";

const app = new cdk.App();
new ChatGptLineBotSampleStack(app, "ChatGptLineBotSampleStack", {
  env: {
    region: "ap-northeast-1",
  },
});

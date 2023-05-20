import "source-map-support/register";
import express from "express";
import {
  Client,
  middleware,
  TextMessage,
  validateSignature,
  WebhookEvent,
} from "@line/bot-sdk";
import { ChatCompletionRequestMessage, Configuration, OpenAIApi } from "openai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 } from "uuid";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import advancedFormat from "dayjs/plugin/advancedFormat";
import { orderBy } from "lodash-es";
import { Callback, Context, LexEvent, LexEventSlots } from "aws-lambda";

dayjs.extend(utc);
dayjs.extend(advancedFormat);

const nanoSecondFormat = "YYYY-MM-DDTHH:mm:ss.SSSSSSSSS[Z]";

const messagesTableName = "chatGptLineBotSample-messages";
const messagesTableUserIdIndexName = "chatGptLineBotSample-userIdIndex";

const ddbDocClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "ap-northeast-1",
  })
);

if (process.env.CHANNEL_ACCESS_TOKEN == null) {
  throw new Error("CHANNEL_ACCESS_TOKEN is not set");
}
const lineBotClient = new Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
});

if (process.env.OPEN_AI_API_KEY == null) {
  throw new Error("OPEN_AI_API_KEY is not set");
}
const openAiApi = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPEN_AI_API_KEY,
  })
);

const handleEvent = async (event: WebhookEvent) => {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userId = event.source.userId!;
  const userMessageContent = event.message.text;

  // 会話中ユーザのこれまでの発言履歴を取得する
  const { Items: messages = [] } = await ddbDocClient.send(
    new QueryCommand({
      TableName: messagesTableName,
      IndexName: messagesTableUserIdIndexName,
      KeyConditionExpression: "#userId = :userId",
      ExpressionAttributeNames: {
        "#userId": "userId",
      },
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    })
  );

  // ユーザの発言を保存する
  await ddbDocClient.send(
    new PutCommand({
      TableName: messagesTableName,
      Item: {
        id: v4(),
        content: userMessageContent,
        userId: userId,
        typedAt: dayjs().format(nanoSecondFormat),
        role: "user",
      },
    })
  );

  // 時系列順にソートする
  const orderedMessages = orderBy(messages, "typedAt", "asc");

  // 最新3件を取得
  const queriedMessages = orderedMessages.splice(-3);

  // 最新3件より古い会話を削除する
  await ddbDocClient.send(
    new BatchWriteCommand({
      RequestItems: {
        [messagesTableName]: orderedMessages.map((message) => ({
          DeleteRequest: {
            Key: {
              id: message.id,
            },
          },
        })),
      },
    })
  );

  // ユーザとChatGPTの会話履歴をChatGPT APIに投げ、返答を得る
  const completion = await openAiApi.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      ...queriedMessages.map(
        (message) =>
          ({
            role: message.role,
            content: message.content,
          } as ChatCompletionRequestMessage)
      ),
      {
        role: "user",
        content: userMessageContent,
      },
    ],
  });
  const chatGptMessageContent = completion.data.choices[0].message?.content!;

  // ChatGPTの発言をLINE返信する
  const repliedMessage: TextMessage = {
    type: "text",
    text: chatGptMessageContent,
  };
  await lineBotClient.replyMessage(event.replyToken, repliedMessage);

  // ChatGPTの発言を保存する
  await ddbDocClient.send(
    new PutCommand({
      TableName: messagesTableName,
      Item: {
        id: v4(),
        content: chatGptMessageContent,
        userId: userId,
        typedAt: dayjs().format(nanoSecondFormat),
        role: "assistant",
      },
    })
  );
};

const app = express();
app.use(
  // 署名検証+JSONパースのミドルウェア
  middleware({
    channelSecret: process.env.CHANNEL_SECRET ?? "",
  })
);

export const handler = async (
  event: any,
  _context: Context,
  _callback: Callback
) => {
  if (process.env.CHANNEL_SECRET == null) {
    throw new Error("CHANNEL_SECRET is not set");
  }
  console.info(JSON.stringify(event));

  const isValid = validateSignature(
    event.rawBody,
    process.env.CHANNEL_SECRET,
    event.params.header["x-line-signature"]
  );
  if (!isValid) {
    throw new Error("Invalid signature");
  }

  const events: WebhookEvent[] = event.body.events;
  console.info(JSON.stringify(events));

  const results = await Promise.all(events.map(handleEvent));
  console.info(JSON.stringify(results));
};

import "source-map-support/register";
import serverlessExpress from "@vendia/serverless-express";
import express from "express";
import { Client, middleware, TextMessage, WebhookEvent } from "@line/bot-sdk";
import { ChatCompletionRequestMessage, Configuration, OpenAIApi } from "openai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 } from "uuid";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import advancedFormat from "dayjs/plugin/advancedFormat";
import { orderBy } from "lodash-es";

dayjs.extend(utc);
dayjs.extend(advancedFormat);

const nanoSecondFormat = "YYYY-MM-DDTHH:mm:ss.SSSSSSSSS[Z]";

const messagesTableName = "messages";

const ddbDocClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "ap-northeast-1",
  })
);

const lineBotClient = new Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN ?? "",
  channelSecret: process.env.CHANNEL_SECRET ?? "",
});

const openAiApi = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPEN_AI_SECRET ?? "",
  })
);

const handleEvent = async (event: WebhookEvent) => {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userId = event.source.userId!;
  const userMessageContent = event.message.text;
  // ユーザの発言履歴を保存する
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

  // 会話中ユーザのこれまでの発言履歴を取得する
  const { Items: messages = [] } = await ddbDocClient.send(
    new QueryCommand({
      TableName: messagesTableName,
      IndexName: "userIdIndex",
      KeyConditionExpression: "#userId = :userId",
      ExpressionAttributeNames: {
        "#userId": "userId",
      },
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    })
  );

  // 時系列順にソートする
  const queriedMessages: ChatCompletionRequestMessage[] = orderBy(
    messages,
    "typedAt",
    "asc"
  ).map(
    (message) =>
      ({
        role: message.role,
        content: message.content,
      } as ChatCompletionRequestMessage)
  );

  // ユーザとChatGPTの会話履歴をChatGPT APIに投げ、返答を得る
  const completion = await openAiApi.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content:
          "あなたは「くらにゃん」です。名前を聞かれたら、「くらにゃん」と答えてください。くらにゃんはWebフロントエンドプログラマーの傍ら、クラスメソッド株式会社の広報係をしています。クラスメソッドはAWSリセール、Webサービス受託開発などを手掛ける日本のIT企業です。DevelopersIO（ https://dev.classmethod.jp/ ）というテックブログが有名です。くらにゃんは静的型付けのメリットから、JavaScriptよりTypeScriptでコーディングすることを好みます。",
      },
      {
        role: "system",
        content: "以後、語尾ににゃんを付けて話して下さい。",
      },
      {
        role: "system",
        content: "一人称を「某」にしてください。",
      },
      {
        role: "system",
        content:
          "敬語を使うのをやめてください。また、絵文字をたくさん使って話してください。",
      },
    ].concat(queriedMessages) as ChatCompletionRequestMessage[],
  });

  const chatGptMessageContent = completion.data.choices[0].message?.content!;
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

  // ChatGPTの発言をパラメータにLINE MessagingAPIを叩く
  const repliedMessage: TextMessage = {
    type: "text",
    text: chatGptMessageContent,
  };
  return lineBotClient.replyMessage(event.replyToken, repliedMessage);
};

const app = express();
app.use(
  // 署名検証+JSONパースのミドルウェア
  middleware({
    channelSecret: process.env.CHANNEL_SECRET ?? "",
  })
);

app.post("/webhook", async (req, res) => {
  try {
    const events: WebhookEvent[] = req.body.events;

    const results = await Promise.all(events.map(handleEvent));
    return res.json(results);
  } catch (err) {
    console.error(err);
    return res.status(500);
  }
});

export default app;

export const handler = serverlessExpress({ app });

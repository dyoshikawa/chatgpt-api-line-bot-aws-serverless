import type { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDBテーブル
    const messagesTable = new cdk.aws_dynamodb.Table(this, "messagesTable", {
      tableName: "messages",
      partitionKey: {
        name: "id",
        type: cdk.aws_dynamodb.AttributeType.STRING,
      },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    messagesTable.addGlobalSecondaryIndex({
      indexName: "userIdIndex",
      partitionKey: {
        name: "userId",
        type: cdk.aws_dynamodb.AttributeType.STRING,
      },
    });

    // LINEとOpenAIの各種シークレット・APIキーをSSMパラメータストアから取得
    const lineMessagingApiChannelSecret =
      cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        "lineMessagingApiChannelSecret"
      );
    const lineMessagingApiChannelAccessToken =
      cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        "lineMessagingApiChannelAccessToken"
      );
    const openAiSecret = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "openAiSecret"
    );

    // APIGW Lambda関数
    const apiFn = new cdk.aws_lambda_nodejs.NodejsFunction(this, "apiFn", {
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      entry: "../server/src/handler.ts",
      environment: {
        // 環境変数にシークレットとAPIキーをセット
        CHANNEL_SECRET: lineMessagingApiChannelSecret,
        CHANNEL_ACCESS_TOKEN: lineMessagingApiChannelAccessToken,
        OPEN_AI_SECRET: openAiSecret,
      },
      bundling: {
        sourceMap: true,
      },
      timeout: cdk.Duration.seconds(29),
    });
    messagesTable.grantReadWriteData(apiFn);

    // APIGW
    const api = new cdk.aws_apigateway.RestApi(this, "api", {
      deployOptions: {
        tracingEnabled: true,
        stageName: "api",
      },
    });
    api.root.addProxy({
      defaultIntegration: new cdk.aws_apigateway.LambdaIntegration(apiFn),
    });
  }
}

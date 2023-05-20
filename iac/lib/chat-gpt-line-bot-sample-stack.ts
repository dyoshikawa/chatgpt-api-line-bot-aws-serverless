import type { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";

export class ChatGptLineBotSampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDBテーブル
    const messagesTable = new cdk.aws_dynamodb.Table(this, "messagesTable", {
      tableName: "chatGptLineBotSample-messages",
      partitionKey: {
        name: "id",
        type: cdk.aws_dynamodb.AttributeType.STRING,
      },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    messagesTable.addGlobalSecondaryIndex({
      indexName: "chatGptLineBotSample-userIdIndex",
      partitionKey: {
        name: "userId",
        type: cdk.aws_dynamodb.AttributeType.STRING,
      },
    });

    // LINEとOpenAIの各種シークレット・APIキーをSSMパラメータストアから取得
    const lineMessagingApiChannelSecret =
      cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        "chatGptLineBotSample-lineMessagingApiChannelSecret"
      );
    const lineMessagingApiChannelAccessToken =
      cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        "chatGptLineBotSample-lineMessagingApiChannelAccessToken"
      );
    const openAiApiKey = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "chatGptLineBotSample-openAiApiKey"
    );

    // APIGW Lambda関数
    const apiFn = new cdk.aws_lambda_nodejs.NodejsFunction(this, "apiFn", {
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      entry: "../server/src/handler.ts",
      environment: {
        // 環境変数にシークレットとAPIキーをセット
        CHANNEL_SECRET: lineMessagingApiChannelSecret,
        CHANNEL_ACCESS_TOKEN: lineMessagingApiChannelAccessToken,
        OPEN_AI_API_KEY: openAiApiKey,
      },
      bundling: {
        sourceMap: true,
      },
      timeout: cdk.Duration.minutes(5),
    });
    messagesTable.grantReadWriteData(apiFn);

    // APIGW
    const api = new cdk.aws_apigateway.RestApi(this, "api", {
      restApiName: "chatGptLineBotSample-api",
      deployOptions: {
        tracingEnabled: true,
        stageName: "api",
      },
    });
    api.root.addMethod(
      "POST",
      new cdk.aws_apigateway.LambdaIntegration(apiFn, {
        proxy: false,
        requestParameters: {
          "integration.request.header.X-Amz-Invocation-Type": "'Event'",
        },
        passthroughBehavior:
          cdk.aws_apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestTemplates: {
          // AWSマネコンのAPIGW>統合リクエスト>マッピングテンプレート>application/json>テンプレートの生成>メソッドリクエストのパススルーをベースに記述
          "application/json": `
          ##  See http://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html
          ##  This template will pass through all parameters including path, querystring, header, stage variables, and context through to the integration endpoint via the body/payload
          #set($allParams = $input.params())
          {
          "body" : $input.json('$'),
          "rawBody": "$util.escapeJavaScript($input.body)",
          "params" : {
          #foreach($type in $allParams.keySet())
              #set($params = $allParams.get($type))
          "$type" : {
              #foreach($paramName in $params.keySet())
              "$paramName" : "$util.escapeJavaScript($params.get($paramName))"
                  #if($foreach.hasNext),#end
              #end
          }
              #if($foreach.hasNext),#end
          #end
          },
          "stage-variables" : {
          #foreach($key in $stageVariables.keySet())
          "$key" : "$util.escapeJavaScript($stageVariables.get($key))"
              #if($foreach.hasNext),#end
          #end
          },
          "context" : {
              "account-id" : "$context.identity.accountId",
              "api-id" : "$context.apiId",
              "api-key" : "$context.identity.apiKey",
              "authorizer-principal-id" : "$context.authorizer.principalId",
              "caller" : "$context.identity.caller",
              "cognito-authentication-provider" : "$context.identity.cognitoAuthenticationProvider",
              "cognito-authentication-type" : "$context.identity.cognitoAuthenticationType",
              "cognito-identity-id" : "$context.identity.cognitoIdentityId",
              "cognito-identity-pool-id" : "$context.identity.cognitoIdentityPoolId",
              "http-method" : "$context.httpMethod",
              "stage" : "$context.stage",
              "source-ip" : "$context.identity.sourceIp",
              "user" : "$context.identity.user",
              "user-agent" : "$context.identity.userAgent",
              "user-arn" : "$context.identity.userArn",
              "request-id" : "$context.requestId",
              "resource-id" : "$context.resourceId",
              "resource-path" : "$context.resourcePath"
              }
          }
          
`.trim(),
        },
        integrationResponses: [
          {
            statusCode: "202",
          },
        ],
      }),
      {
        methodResponses: [
          {
            statusCode: "202",
          },
        ],
      }
    );

    // WAF Web ACL
    const webAcl = new cdk.aws_wafv2.CfnWebACL(this, "wafV2WebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: "wafV2WebAcl",
      },
      rules: [
        // レート制限を設定
        // https://docs.aws.amazon.com/ja_jp/waf/latest/developerguide/waf-rule-statement-type-rate-based.html
        {
          name: "RateLimit",
          priority: 0,
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: "IP",
            },
          },
          action: {
            block: {},
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimit",
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
          },
        },
      ],
    });

    // APIGWとWebACLを紐付ける
    const webAclAssociation = new cdk.aws_wafv2.CfnWebACLAssociation(
      this,
      "webAclAssociation",
      {
        resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
        webAclArn: webAcl.attrArn,
      }
    );
    webAclAssociation.addDependency(webAcl);
    webAclAssociation.addDependency(
      api.deploymentStage.node.defaultChild as cdk.CfnResource
    );
  }
}

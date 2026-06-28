// CDK stack — the real AWS infra for build-order step 1:
//   - DynamoDB single table `MusicLeague` (PK/SK + GSI1 "my leagues")
//   - Cognito user pool + app client (OUR identity, separate from Spotify)
//   - API Gateway REST API, Cognito-authorized, proxying to one Lambda that
//     runs the same route table the local dev server does (src/http/lambda.ts)
//
// `cdk deploy` provisions it. Nothing here is needed for local development —
// `npm run dev` runs the identical handlers against the in-memory store.

import { Stack, type StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MusicLeagueStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- DynamoDB single table ----
    const table = new dynamodb.Table(this, "MusicLeagueTable", {
      tableName: "MusicLeague",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN, // never auto-delete league data
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // GSI1 — "my leagues": query USER#<id> → that user's memberships.
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- Cognito (our accounts; Spotify auth stays host-only, elsewhere) ----
    const userPool = new cognito.UserPool(this, "MusicLeagueUserPool", {
      userPoolName: "music-league",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { preferredUsername: { required: false, mutable: true } },
      passwordPolicy: { minLength: 8, requireLowercase: true, requireDigits: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("WebClient", {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
    });

    // ---- API Lambda (one function, internal route table) ----
    const apiFn = new NodejsFunction(this, "ApiFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: join(__dirname, "../src/http/lambda.ts"),
      handler: "handler",
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        USER_POOL_ID: userPool.userPoolId,
      },
      // ESM output matches the source; esbuild resolves the `.ts` import
      // extensions and tree-shakes the unused (local-server) paths.
      bundling: { format: OutputFormat.ESM, minify: false, target: "node22" },
    });

    table.grantReadWriteData(apiFn);
    userPool.grant(apiFn, "cognito-idp:ListUsers"); // resolve display names

    // ---- API Gateway REST + Cognito authorizer ----
    const api = new apigateway.RestApi(this, "MusicLeagueApi", {
      restApiName: "music-league-api",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "Authorizer", {
      cognitoUserPools: [userPool],
    });

    // Catch-all proxy: every path/method flows to the Lambda, which owns routing.
    const integration = new apigateway.LambdaIntegration(apiFn);
    const proxy = api.root.addProxy({ anyMethod: false });
    proxy.addMethod("ANY", integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    // Allow the root path too (e.g. POST /leagues lives under /{proxy+}, but
    // GET /leagues is a single segment — addProxy covers it via {proxy+}).

    // ---- Outputs the frontend needs ----
    new CfnOutput(this, "ApiUrl", { value: api.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}

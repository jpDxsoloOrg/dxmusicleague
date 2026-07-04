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
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
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

    // ---- Spotify app credentials ----
    // Created empty here; the real {clientId, clientSecret} is set out-of-band
    // (CLI / console) so it never lands in source or the CloudFormation template.
    const spotifySecret = new secretsmanager.Secret(this, "SpotifySecret", {
      secretName: "music-league/spotify",
      description: "Spotify app credentials JSON {clientId, clientSecret} — set out-of-band.",
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
        SPOTIFY_SECRET_ID: spotifySecret.secretArn,
      },
      // ESM output matches the source; esbuild resolves the `.ts` import
      // extensions and tree-shakes the unused (local-server) paths.
      bundling: { format: OutputFormat.ESM, minify: false, target: "node22" },
    });

    table.grantReadWriteData(apiFn);
    userPool.grant(apiFn, "cognito-idp:ListUsers"); // resolve display names
    spotifySecret.grantRead(apiFn);

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

    // ---- Static site hosting (S3 + CloudFront) ----
    // The built Vite app (`dist/`) is synced to this bucket out-of-band. The
    // bucket stays private; CloudFront reaches it via Origin Access Control, so
    // the assets are only served through the CDN (HTTPS), never S3 directly.
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Holds only build output (no data) — safe to empty + drop on teardown.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      // SPA routing: React Router owns the path, so any missing S3 key (a deep
      // link like /leagues/xyz) must return index.html with 200, not S3's 403/404.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // ---- Outputs the frontend needs ----
    new CfnOutput(this, "ApiUrl", { value: api.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });
  }
}

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Stack,
  type StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { HttpApi, CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

export interface TextToPodcastStackProps extends StackProps {
  anthropicApiKey: string;
  appSecret: string;
  claudeModel: string;
  defaultVoice: string;
  pollyEngine: string;
  pollRateMinutes: number;
  maxItemsPerPoll: number;
  // Base URL the web UI calls. Blank falls back to this stack's own API
  // endpoint, so it works with no configuration; override for a custom domain.
  apiBaseUrl: string;
}

export class TextToPodcastStack extends Stack {
  constructor(scope: Construct, id: string, props: TextToPodcastStackProps) {
    super(scope, id, props);

    // --- Storage --------------------------------------------------------------
    const table = new dynamodb.Table(this, "AppTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // List-by-type index: query all Feeds / Items / Episodes, newest first.
    table.addGlobalSecondaryIndex({
      indexName: "byType",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Public-read media bucket: podcast apps must reach the feed + audio. Content
    // lives under unguessable paths, so public GET is fine; ACLs stay blocked.
    const media = new s3.Bucket(this, "Media", {
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const mediaBaseUrl = `https://${media.bucketRegionalDomainName}`;

    const commonEnv = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: media.bucketName,
      MEDIA_BASE_URL: mediaBaseUrl,
      ANTHROPIC_API_KEY: props.anthropicApiKey,
      APP_SECRET: props.appSecret,
      CLAUDE_MODEL: props.claudeModel,
      DEFAULT_VOICE: props.defaultVoice,
      POLLY_ENGINE: props.pollyEngine,
      MAX_ITEMS_PER_POLL: String(props.maxItemsPerPoll),
    };

    const fn = (name: string, dir: string, timeout = 60) =>
      new lambda.Function(this, name, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(join(ROOT, "dist", dir)),
        memorySize: 512,
        timeout: Duration.seconds(timeout),
        environment: commonEnv,
      });

    // --- Functions ------------------------------------------------------------
    const apiFn = fn("ApiFn", "api", 60);
    const pollerFn = fn("PollerFn", "poller", 120);
    const synthFn = fn("SynthCallbackFn", "synthCallback", 60);
    // The worker runs the slow pipeline steps (page fetch, Claude, Polly) off
    // the API request path, so it gets a generous timeout — a long article's
    // scripting must never be cut short the way a 60s API request could be.
    const workerFn = fn("WorkerFn", "worker", 300);

    for (const f of [apiFn, pollerFn, synthFn, workerFn]) {
      table.grantReadWriteData(f);
      media.grantReadWrite(f);
    }
    // Only the worker synthesizes audio now (the API/poller just enqueue work).
    const pollyPolicy = new iam.PolicyStatement({
      actions: ["polly:StartSpeechSynthesisTask", "polly:GetSpeechSynthesisTask"],
      resources: ["*"],
    });
    workerFn.addToRolePolicy(pollyPolicy);

    // The API and poller hand background jobs to the worker via async invoke.
    workerFn.grantInvoke(apiFn);
    workerFn.grantInvoke(pollerFn);
    apiFn.addEnvironment("WORKER_FUNCTION_NAME", workerFn.functionName);
    pollerFn.addEnvironment("WORKER_FUNCTION_NAME", workerFn.functionName);

    // --- HTTP API -------------------------------------------------------------
    const httpApi = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("ApiIntegration", apiFn),
      corsPreflight: {
        allowOrigins: ["*"],
        allowHeaders: ["content-type", "x-api-key"],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.OPTIONS,
        ],
      },
    });

    // --- Schedule the poller --------------------------------------------------
    new events.Rule(this, "PollSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(props.pollRateMinutes)),
      targets: [new targets.LambdaFunction(pollerFn)],
    });

    // --- Polly finish -> finalize + rebuild feed ------------------------------
    media.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(synthFn),
      { prefix: "audio/", suffix: ".mp3" },
    );

    // --- Static web UI into app/ ----------------------------------------------
    // The UI reads its API base URL from config.js at runtime instead of a
    // hand-entered Settings field. Overwrite that file at deploy time with the
    // configured URL (or this stack's own API endpoint when unset), so the UI
    // is preconfigured. Source.data resolves the endpoint token at deploy time.
    const webApiBaseUrl = props.apiBaseUrl || httpApi.apiEndpoint;
    new s3deploy.BucketDeployment(this, "WebDeploy", {
      sources: [
        s3deploy.Source.asset(join(ROOT, "web")),
        s3deploy.Source.data(
          "config.js",
          `window.APP_CONFIG = { apiBaseUrl: "${webApiBaseUrl}" };\n`,
        ),
      ],
      destinationBucket: media,
      destinationKeyPrefix: "app",
      prune: false,
    });

    // --- Outputs --------------------------------------------------------------
    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "WebAppUrl", { value: `${mediaBaseUrl}/app/index.html` });
    new CfnOutput(this, "MediaBaseUrl", { value: mediaBaseUrl });
  }
}

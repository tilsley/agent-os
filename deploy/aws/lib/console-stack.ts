import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

export interface ConsoleStackProps extends cdk.StackProps {
  /** The serverless front door the console calls (ADR-0031's Function URL). */
  apiUrl: string;
  /** Cognito wiring for the hosted-UI login (ADR-0032). */
  auth: { hostedUiBaseUrl: string; clientId: string };
  /** Where run traces land (ADR-0035) — enables the console's per-run trace link. */
  grafana?: { url: string; tracesDatasourceUid: string };
  /**
   * Custom domain for the console (ADR-0043's pattern applied to the UI). The
   * certificate comes from a UsEast1CertStack — CloudFront only accepts us-east-1
   * certs, so it can't be minted here (this stack is regional) and crosses stacks
   * via `crossRegionReferences`. Unset ⇒ the CloudFront default domain (dev/POC).
   * `additionalDomains` (each needs a cert SAN) also alias here and get 301'd to
   * the canonical domain — used for the bare creance.… apex, which must resolve
   * for Cognito's custom auth domain to accept auth.creance.… (parent A record).
   */
  edge?: {
    domainName: string;
    hostedZone: { id: string; name: string };
    certificate: acm.ICertificate;
    additionalDomains?: string[];
  };
}

/**
 * ConsoleStack — the web console's static hosting (ADR-0032): a private S3 bucket
 * behind CloudFront (OAC), serving the built SPA from `apps/console/dist`.
 * BUILD FIRST: `bun run --cwd apps/console build` — synth fails without dist/.
 *
 * Configuration travels as a DEPLOYED file, not a build-time bake: the deployment
 * writes /config.json from this stack's props (cross-stack refs to the front door
 * URL + Cognito ids), so one bundle serves any environment and a config change is
 * a redeploy of this stack, not a rebuild of the app.
 *
 * Custom domain (ADR-0043 pattern): when `edge` is set the distribution answers on
 * the console subdomain (cert from ConsoleCertStack in us-east-1, Route53 alias
 * here). The domain must ALSO appear in the user-pool client's callback URLs
 * (cdk.json `consoleCallbackUrls`) or the hosted-UI login bounces.
 */
export class ConsoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsoleStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC: no orphaned buckets
      autoDeleteObjects: true,
    });

    // ADR-0043's "no raw URL remains", applied to the UI: CloudFront's default
    // *.cloudfront.net hostname can't be switched off, so a viewer-request function
    // 301s any request that didn't arrive on the custom domain. Must hang off EVERY
    // behavior — /index.html and /config.json have their own and would bypass it.
    const canonicalHost = props.edge
      ? new cloudfront.Function(this, "CanonicalHost", {
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.headers.host.value !== "${props.edge.domainName}") {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: "https://${props.edge.domainName}" + request.uri } },
    };
  }
  return request;
}`),
        })
      : undefined;
    const functionAssociations = canonicalHost
      ? [{ function: canonicalHost, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
      : undefined;

    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "agent-os console (ADR-0032)",
      defaultRootObject: "index.html",
      ...(props.edge
        ? {
            domainNames: [props.edge.domainName, ...(props.edge.additionalDomains ?? [])],
            certificate: props.edge.certificate,
          }
        : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // hashed Vite assets are immutable — cache hard by default…
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations,
      },
      additionalBehaviors: {
        // …but the two mutable files must always revalidate: index.html names the
        // current hashed bundle; config.json is rewritten on every deploy.
        "/index.html": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations,
        },
        "/config.json": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations,
        },
      },
      // SPA fallback: unknown paths (hash routes resolve client-side, but also any
      // deep link) get index.html, not an S3 error page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    new s3deploy.BucketDeployment(this, "Deploy", {
      destinationBucket: bucket,
      distribution, // invalidate on deploy
      distributionPaths: ["/*"],
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "..", "..", "..", "apps", "console", "dist")),
        // LAST wins: the deployed config overrides any dev config.json in dist/
        s3deploy.Source.jsonData("config.json", {
          apiUrl: props.apiUrl,
          hostedUiBaseUrl: props.auth.hostedUiBaseUrl,
          clientId: props.auth.clientId,
          ...(props.grafana ? { grafana: props.grafana } : {}),
        }),
      ],
    });

    if (props.edge) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: props.edge.hostedZone.id,
        zoneName: props.edge.hostedZone.name,
      });
      new route53.ARecord(this, "Alias", {
        zone,
        recordName: props.edge.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
      for (const extra of props.edge.additionalDomains ?? []) {
        new route53.ARecord(this, `Alias-${extra}`, {
          zone,
          recordName: extra,
          target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
        });
      }
    }

    new cdk.CfnOutput(this, "ConsoleUrl", {
      value: props.edge ? `https://${props.edge.domainName}/` : `https://${distribution.distributionDomainName}/`,
    });
  }
}

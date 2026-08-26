import * as fs from "fs";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";

// The CDK app runs under bun (cdk.json: "app": "bun bin/agent-os.ts"), so the
// built-in YAML parser is available — no yaml dependency.
declare const Bun: { YAML: { parse(text: string): unknown } };

export interface SpecRestApiEdgeProps {
  /** Absolute path to the service's PURE OpenAPI contract (no x-amazon-* extensions). */
  specPath: string;
  /** The service's single router Lambda — every operation proxies here (the app
   *  owns routing and auth; the edge owns shape validation and the domain). */
  handler: lambda.IFunction;
  /** e.g. `api.creance.nathantilsley.com`. */
  domainName: string;
  hostedZone: { id: string; name: string };
  apiName: string;
}

/**
 * SpecRestApiEdge — the spec-driven edge (ADR-0043): one pure OpenAPI contract
 * in, one API Gateway REST API + custom domain out.
 *
 * The AWS wiring is injected HERE at synth, not written into the spec:
 *   - every declared operation gets an aws_proxy integration to the ONE router
 *     Lambda (from its real functionArn — no logical-ID overrides, no Fn::Sub
 *     strings; a renamed construct is a compile-time change, not a runtime 500);
 *   - an OPTIONS method is added per path (proxied too — the app answers
 *     preflight via withCors, so CORS behavior is identical on the pod profile);
 *   - request-BODY validation is enabled document-wide, so a malformed payload
 *     is refused at the edge before a Lambda ever cold-starts.
 * failOnWarnings is ON: a contract error fails the deploy, loudly — the whole
 * point of spec-first.
 */
export class SpecRestApiEdge extends Construct {
  readonly api: apigateway.SpecRestApi;
  /** The edge's address: `https://<domainName>`. */
  readonly url: string;

  constructor(scope: Construct, id: string, props: SpecRestApiEdgeProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // --- overlay: pure contract -> API Gateway definition -------------------
    const spec = Bun.YAML.parse(fs.readFileSync(props.specPath, "utf8")) as any;
    const integration = {
      type: "aws_proxy",
      httpMethod: "POST", // Lambda invocations are always POST, whatever the API method
      uri: `arn:aws:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${props.handler.functionArn}/invocations`,
      passthroughBehavior: "when_no_match",
    };
    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
        if (item[method]) {
          item[method]["x-amazon-apigateway-integration"] = integration;
          // `security` documents the app-layer bearer check (ADR-0026) — it is not
          // an API Gateway authorizer. Left in, APIGW warns "specified security, but
          // no custom authorizers were created" and failOnWarnings turns that into a
          // deploy failure. Strip it from the edge copy; the source contract keeps it.
          delete item[method].security;
        }
      }
      if (!item.options) {
        item.options = {
          summary: "CORS preflight (answered by the app's withCors)",
          responses: { "204": { description: "Preflight headers." } },
          "x-amazon-apigateway-integration": integration,
        };
      }
    }
    delete spec.security;
    if (spec.components) delete spec.components.securitySchemes;
    spec["x-amazon-apigateway-request-validators"] = {
      body: { validateRequestBody: true, validateRequestParameters: false },
    };
    spec["x-amazon-apigateway-request-validator"] = "body";

    // --- the REST API --------------------------------------------------------
    this.api = new apigateway.SpecRestApi(this, "Api", {
      restApiName: props.apiName,
      apiDefinition: apigateway.ApiDefinition.fromInline(spec),
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      failOnWarnings: true, // a contract error is a deploy error, not a runtime 500
      deployOptions: { stageName: "prod", metricsEnabled: true },
    });
    props.handler.addPermission(`${id}Invoke`, {
      principal: new cdk.aws_iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: this.api.arnForExecuteApi("*", "/*", "prod"),
    });
    // Edge-generated errors (validation 400s, unmatched routes) never reach the
    // app's withCors — stamp the header here so browsers can read them.
    this.api.addGatewayResponse("Cors4xx", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: { "Access-Control-Allow-Origin": "'*'" },
    });
    this.api.addGatewayResponse("Cors5xx", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: { "Access-Control-Allow-Origin": "'*'" },
    });

    // --- custom domain (the reason this edge exists) -------------------------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZone.id,
      zoneName: props.hostedZone.name,
    });
    const certificate = new acm.Certificate(this, "Cert", {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const domain = this.api.addDomainName("Domain", {
      domainName: props.domainName,
      certificate,
      endpointType: apigateway.EndpointType.REGIONAL,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
    });
    new route53.ARecord(this, "Alias", {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayDomain(domain)),
    });

    this.url = `https://${props.domainName}`;
  }
}

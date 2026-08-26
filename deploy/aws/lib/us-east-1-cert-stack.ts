import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";

export interface UsEast1CertStackProps extends cdk.StackProps {
  domainName: string;
  hostedZone: { id: string; name: string };
  /** Extra names on the same cert (e.g. the bare creance.… apex on the console cert). */
  subjectAlternativeNames?: string[];
}

/**
 * UsEast1CertStack — ONLY a TLS certificate, pinned to us-east-1. CloudFront
 * accepts certs from nowhere else, and both edges that need one here are
 * CloudFront under the hood: the console distribution (AgentOsConsoleCert) and
 * Cognito's hosted-UI custom domain (AgentOsAuthCert). The API edges' certs are
 * regional and live inline in SpecRestApiEdge. Producer and consumer both set
 * `crossRegionReferences: true` so CDK ferries the cert ARN across regions.
 */
export class UsEast1CertStack extends cdk.Stack {
  readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: UsEast1CertStackProps) {
    super(scope, id, props);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZone.id,
      zoneName: props.hostedZone.name,
    });
    // The construct id encodes the domain set ON PURPOSE: changing domains replaces
    // the cert (new ARN), but CDK's cross-region ExportWriter diffs exports by NAME
    // only — a new value under the same export name is silently never written to SSM,
    // and the consumer keeps deploying against the old cert ARN (bit us adding the
    // apex SAN). A new construct id ⇒ new export name ⇒ the new ARN actually crosses.
    const certId = ["Cert", props.domainName, ...(props.subjectAlternativeNames ?? [])]
      .join("-")
      .replace(/[^A-Za-z0-9-]/g, "");
    this.certificate = new acm.Certificate(this, certId, {
      domainName: props.domainName,
      subjectAlternativeNames: props.subjectAlternativeNames,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}

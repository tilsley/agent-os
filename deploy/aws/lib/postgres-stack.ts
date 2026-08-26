import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * PostgresStack — the full-mode budget/memory store (ADR-0023/0026/0027): Aurora
 * Serverless v2, PostgreSQL engine, **scaling to 0 ACUs** (auto-pause) so it costs
 * ~nothing idle — the "spin up full mode for an hour, spin back down" store.
 *
 *  - One conditional UPDATE *is* the budget reserve (PostgresSpendStore in the
 *    LiteLLM gateway); later RunStore/StateStore/pgvector ride the same cluster.
 *  - IAM database auth is ENABLED (the keyless path — the hook's token-refresh
 *    wiring is the documented follow-up); the master secret lives in Secrets
 *    Manager (managed, rotated — not a static key in code).
 *  - Self-contained minimal VPC: 2 AZs, PUBLIC subnets only, NO NAT gateways
 *    (= $0 idle networking). Dev access is opt-in: pass
 *    `-c dbAllowedCidr=<your-ip>/32` to open 5432; default is NO ingress.
 *    (Self-contained on purpose — the EKS-side VPC is eksctl's, not CDK's.)
 *  - DESTROY removal policy: this is a POC store — `cdk destroy AgentOsPostgres`
 *    cleans up completely.
 *
 * Idle cost: $0 compute while paused (resume ~15 s on first connect) + storage
 * pennies + one Secrets Manager secret (~$0.40/mo).
 */
export class PostgresStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0, // no NAT = no idle networking cost
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
    });

    const sg = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc,
      description: "agent-os postgres - no ingress by default; opt-in via -c dbAllowedCidr (ASCII only here)",
      allowAllOutbound: false,
    });
    const allowedCidr = this.node.tryGetContext("dbAllowedCidr") as string | undefined;
    if (allowedCidr) {
      sg.addIngressRule(ec2.Peer.ipv4(allowedCidr), ec2.Port.tcp(5432), "dev access (deploy-time opt-in)");
    }

    const db = new rds.DatabaseCluster(this, "SpendDb", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6, // >=16.3 required for 0-ACU pause
      }),
      serverlessV2MinCapacity: 0, // scale-to-zero: auto-pause when idle
      serverlessV2MaxCapacity: 1, // 1 ACU ≈ 2 GiB — plenty for the POC
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: true, // reachable for the hour-test; SG (above) is the lock
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [sg],
      defaultDatabaseName: "agentos",
      iamAuthentication: true, // the keyless path (ADR-0026 follow-up wires the token refresh)
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM database auth (the keyless app path): a managed policy granting rds-db:connect
    // to the `agentos_app` DB user (created with the rds_iam role). This is the reusable
    // ARTIFACT — in EKS it attaches to the pod's role (IRSA). For the local laptop test,
    // pass `-c dbConnectUser=<iam-user>` to attach it — but only if that user LACKS the
    // permission and has policy headroom (an Administrator/dev user already has rds-db:connect,
    // and is often at the 10-managed-policies-per-user limit, so leave dbConnectUser unset).
    // The ARN's resource is the cluster's resource id, not its name.
    const dbUser = "agentos_app";
    const connectPolicy = new iam.ManagedPolicy(this, "RdsIamConnect", {
      statements: [
        new iam.PolicyStatement({
          actions: ["rds-db:connect"],
          resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:${db.clusterResourceIdentifier}/${dbUser}`],
        }),
      ],
    });
    const connectUser = this.node.tryGetContext("dbConnectUser") as string | undefined;
    if (connectUser) connectPolicy.attachToUser(iam.User.fromUserName(this, "DbConnectUser", connectUser));

    new cdk.CfnOutput(this, "RdsIamUser", { value: dbUser });
    new cdk.CfnOutput(this, "RdsIamConnectPolicyArn", { value: connectPolicy.managedPolicyArn });
    new cdk.CfnOutput(this, "ClusterResourceId", { value: db.clusterResourceIdentifier });
    new cdk.CfnOutput(this, "Endpoint", { value: db.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, "Port", { value: cdk.Token.asString(db.clusterEndpoint.port) });
    new cdk.CfnOutput(this, "SecretArn", { value: db.secret?.secretArn ?? "n/a" });
    new cdk.CfnOutput(this, "SpendDatabaseUrlHint", {
      value: `postgresql://postgres:<from-secret>@${db.clusterEndpoint.hostname}:5432/agentos`,
      description: "SPEND_DATABASE_URL shape (password from Secrets Manager; IAM auth = follow-up)",
    });
  }
}

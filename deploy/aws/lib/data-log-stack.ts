import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * DataLogStack — observability & tracing (the black box).
 *
 * SKELETON — intended contents:
 *  - OpenSearch domain for trace/span analysis (sized small initially — cost).
 *  - S3 bucket for raw prompt/completion payloads (lifecycle + retention; mind
 *    PII handling — see docs/architecture.md open threads).
 *  - ADOT (OpenTelemetry) Collector — deployed as a DaemonSet (via the ADOT EKS
 *    add-on or the OpenTelemetry Operator). Apps emit OTLP to the node-local
 *    collector (the `record` control / OtelTelemetrySink), which exports to
 *    OpenSearch (traces) + S3 (raw payloads). Spans carry agent_id, run_id,
 *    tokens_spent, tool_calls for step-by-step replay. Optional central gateway
 *    Deployment for tail-sampling (keep errors/slow/sampled only → controls
 *    OpenSearch cost). App code is identical dev↔prod — only the OTLP endpoint
 *    changes; the collector is infra, not app code.
 *  - (Optional) ElastiCache for provider-side caching IF native caching proves
 *    insufficient — not assumed.
 */
export class DataLogStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // TODO: implement during the infra milestone.
  }
}

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * BedrockStack — inference access (the brain) + the `guard` control.
 *
 *  - A Bedrock **Guardrail** (content filters incl. prompt-attack) — the `guard`
 *    control's policy as IaC. Replaces the ad-hoc `agent-os-poc-demo` guardrail
 *    that was created outside CDK; delete that one once this is deployed.
 *  - A scoped **inference** policy: InvokeModel on specific models/profiles only
 *    (not "*") + ApplyGuardrail on the guardrail. Binds to the runtime's
 *    ServiceAccount via EKS Pod Identity (prod).
 */
export class BedrockStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const guardrail = new bedrock.CfnGuardrail(this, "Guardrail", {
      name: "agent-os-poc",
      description: "agent-os content safety: filters incl. prompt attack, PII off for POC",
      blockedInputMessaging: "Blocked by the agent-os guardrail.",
      blockedOutputsMessaging: "Blocked by the agent-os guardrail.",
      contentPolicyConfig: {
        filtersConfig: [
          { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }, // input-only
          { type: "HATE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "INSULTS", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "SEXUAL", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "VIOLENCE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "MISCONDUCT", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
        ],
      },
    });

    const inferencePolicy = new iam.ManagedPolicy(this, "BedrockInvokePolicy", {
      managedPolicyName: "agent-os-bedrock-invoke",
      statements: [
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: [
            `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-lite-v1:0`,
            `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-pro-v1:0`,
            // Claude Haiku for tool-use-heavy agents (coding). Region wildcard, not
            // eu-west-2: eu.* inference profiles fan out to ANY eu region, and the
            // invoke needs foundation-model permission wherever the call lands.
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-*`,
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
            // Claude via the `eu.` cross-region inference profile: invoking the profile
            // fans the call out to the underlying foundation-model in ANY eu region
            // (observed: eu-north-1), so the foundation-model grant needs a region
            // wildcard — the profile ARN alone is not sufficient. Anthropic models are
            // AWS-owned (empty account field). See the /v1/messages Anthropic wire.
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ["bedrock:ApplyGuardrail"],
          resources: [guardrail.attrGuardrailArn],
        }),
      ],
    });

    new cdk.CfnOutput(this, "GuardrailId", { value: guardrail.attrGuardrailId });
    new cdk.CfnOutput(this, "BedrockInvokePolicyArn", { value: inferencePolicy.managedPolicyArn });
  }
}

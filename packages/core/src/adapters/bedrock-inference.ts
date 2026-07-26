/**
 * Bedrock adapter for the InferenceProvider port (think).
 * All Bedrock Converse specifics — message translation, tool-use parsing — are
 * confined here. The loop never sees them.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import type {
  InferenceProvider,
  GenerateOptions,
  Message,
  ToolDef,
  AssistantTurn,
  ToolCall,
} from "../ports";

export class BedrockInferenceProvider implements InferenceProvider {
  readonly name = "bedrock";
  readonly model: string;
  private client: BedrockRuntimeClient;

  // `credentials` (optional) scopes the client to a specific identity — e.g. a
  // tenant's assumed role (ADR-0014). Omitted → the SDK default chain (the
  // platform's ambient creds), which is the prior behaviour.
  constructor(private modelId: string, region: string, credentials?: AwsCredentialIdentityProvider) {
    this.model = modelId;
    // bounded waits: no SDK default request timeout — a stalled converse call would
    // otherwise hang the run silently (same stance as the AgentCore sandbox client)
    this.client = new BedrockRuntimeClient({
      region,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 180_000 },
      ...(credentials ? { credentials } : {}),
    });
  }

  async generate(messages: Message[], tools: ToolDef[], opts: GenerateOptions): Promise<AssistantTurn> {
    const resp = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        messages: messages.map(toBedrock),
        // cap the completion length -> bounds the per-call output cost (ADR-0013)
        inferenceConfig: { maxTokens: opts.maxTokens },
        // Converse rejects an empty toolConfig.tools — only send it when there are tools.
        ...(tools.length > 0
          ? {
              toolConfig: {
                tools: tools.map((t) => ({
                  toolSpec: {
                    name: t.name,
                    description: t.description,
                    inputSchema: { json: t.inputSchema },
                  },
                })),
              },
            }
          : {}),
      }),
    );

    let text: string | undefined;
    const toolCalls: ToolCall[] = [];
    for (const block of resp.output?.message?.content ?? []) {
      if (block.text) text = (text ?? "") + block.text;
      if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId!,
          name: block.toolUse.name!,
          input: (block.toolUse.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      text,
      toolCalls,
      usage: { inputTokens: resp.usage?.inputTokens, outputTokens: resp.usage?.outputTokens },
    };
  }
}

// neutral Message -> Bedrock Converse message
function toBedrock(m: Message): any {
  switch (m.role) {
    case "user":
      return { role: "user", content: [{ text: m.text }] };
    case "assistant": {
      const content: any[] = [];
      if (m.text) content.push({ text: m.text });
      for (const tc of m.toolCalls ?? []) {
        content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.input } });
      }
      return { role: "assistant", content };
    }
    case "tool":
      // tool results go back as a user turn in Converse
      return {
        role: "user",
        content: m.results.map((r) => ({
          toolResult: {
            toolUseId: r.toolCallId,
            content: [{ text: r.output }],
            status: "success",
          },
        })),
      };
  }
}

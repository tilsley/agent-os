/**
 * KubeAgentRegistry — reads Agent definitions from k8s `Agent` custom resources
 * (the `agent-os.io/v1alpha1` CRD). This is the agent control plane's catalog
 * backed by the cluster: `kubectl apply` an Agent, and the runtime can run it.
 * See ADR-0012. Loads in-cluster creds (ServiceAccount) or the local kubeconfig.
 */
import * as k8s from "@kubernetes/client-node";
import type { AgentRegistry, AgentSpec } from "../agents";

const GROUP = "agent-os.io";
const VERSION = "v1alpha1";
const PLURAL = "agents";

function toSpec(obj: any): AgentSpec {
  const s = obj?.spec ?? {};
  return {
    name: obj?.metadata?.name,
    tenant: s.tenant,
    description: s.description,
    model: s.model,
    systemPrompt: s.systemPrompt,
    tools: s.tools,
    maxSteps: s.maxSteps,
    kind: s.kind,
    command: s.command,
  };
}

export class KubeAgentRegistry implements AgentRegistry {
  readonly name = "kube";
  private readonly api: k8s.CustomObjectsApi;

  constructor(private readonly namespace = "agent-os") {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // in-cluster SA token, or ~/.kube/config locally
    this.api = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async get(name: string): Promise<AgentSpec | undefined> {
    try {
      const obj = await this.api.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        name,
      });
      return toSpec(obj);
    } catch (e: any) {
      if (e?.code === 404 || e?.statusCode === 404 || e?.response?.statusCode === 404) return undefined;
      throw e;
    }
  }

  async list(): Promise<AgentSpec[]> {
    const res: any = await this.api.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.namespace,
      plural: PLURAL,
    });
    return (res?.items ?? []).map(toSpec);
  }
}

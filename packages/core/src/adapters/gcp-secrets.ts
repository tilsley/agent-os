/**
 * GCP Secret Manager resolver for the dependency-free GCP profile — one more plain
 * REST call over an ADC bearer token (mirrors ./gcp-auth and the Firestore/Vertex
 * adapters; NO google-cloud SDK in the shared runtime image).
 *
 * Purpose (ADR-0047): keep secret MATERIAL out of the Agent Runtime deploy config.
 * deploy.py passes only a *reference* — e.g. `E2B_API_KEY_SECRET=projects/<p>/secrets/
 * e2b-api-key/versions/latest` — and the loop's own service account fetches the value
 * at startup. The secret never lands in `env_vars` on the reasoningEngine resource, so
 * an `aiplatform` reader can't see it; only `secretmanager.secretAccessor` can.
 */
import { gcpAccessToken } from "./gcp-auth";

type FetchImpl = typeof fetch;

/** Read a Secret Manager secret version payload. `name` is a full resource name:
 *  `projects/{project}/secrets/{secret}/versions/{version|latest}`. */
export async function accessSecret(name: string, fetchImpl: FetchImpl = fetch): Promise<string> {
  const token = await gcpAccessToken();
  const res = await fetchImpl(`https://secretmanager.googleapis.com/v1/${name}:access`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Secret Manager access ${name} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { payload?: { data?: string } };
  const data = body.payload?.data;
  if (data == null) throw new Error(`Secret Manager access ${name}: response had no payload.data`);
  return Buffer.from(data, "base64").toString("utf8");
}

/** If `${envVar}` is already set, no-op. Otherwise, if `${envVar}_SECRET` names a Secret
 *  Manager version, resolve it and set `process.env[envVar]`. Lets a GCP entrypoint pull
 *  secrets by reference at boot without baking values into the deploy config (ADR-0047).
 *  Returns true iff it resolved one. */
export async function resolveSecretEnv(envVar: string, fetchImpl: FetchImpl = fetch): Promise<boolean> {
  if (process.env[envVar]) return false;
  const ref = process.env[`${envVar}_SECRET`];
  if (!ref) return false;
  process.env[envVar] = await accessSecret(ref, fetchImpl);
  return true;
}

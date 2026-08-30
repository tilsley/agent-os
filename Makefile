# agent-os — common commands, with the AWS profile + region always set.
# Override per-invocation:  make deploy AWS_PROFILE=other AWS_REGION=us-east-1
AWS_PROFILE ?= nathan-tilsley-developer
AWS_REGION  ?= eu-west-2
RUNS_TABLE  ?= agent-os-runs

export AWS_PROFILE
export AWS_REGION
export AWS_DEFAULT_REGION = $(AWS_REGION)
export REGION = $(AWS_REGION)            # the app's region env (packages/core/config.ts)

.DEFAULT_GOAL := help

help: ## show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

whoami: ## print the AWS account this profile resolves to (run before deploying!)
	aws sts get-caller-identity

# --- CDK (infra/) ---
bootstrap: ## cdk bootstrap this account/region (one-time)
	cd deploy/aws && bunx cdk bootstrap

synth: ## synth the implemented stacks
	cd deploy/aws && bunx cdk synth AgentOsState AgentOsBedrock

diff: ## diff against what's deployed
	cd deploy/aws && bunx cdk diff AgentOsState AgentOsBedrock

deploy: whoami ## deploy StateStack + BedrockStack (prints identity first)
	cd deploy/aws && bunx cdk deploy AgentOsState AgentOsBedrock

destroy: ## destroy StateStack + BedrockStack
	cd deploy/aws && bunx cdk destroy AgentOsState AgentOsBedrock

outputs: ## print deployed stack outputs (table, role, guardrail id)
	@aws cloudformation describe-stacks --stack-name AgentOsState   --query 'Stacks[0].Outputs' --output table
	@aws cloudformation describe-stacks --stack-name AgentOsBedrock --query 'Stacks[0].Outputs' --output table

# --- web console (ADR-0032) + serverless front door (ADR-0031) ---
deploy-console: whoami ## build the console SPA, then deploy it (S3+CloudFront; auto-invalidates the CDN)
	bun run --cwd apps/console build
	cd deploy/aws && bunx cdk deploy AgentOsConsole

deploy-serverless: whoami ## deploy the agent-runtime front door (Lambda) — needed for authored agent descriptions
	cd deploy/aws && bunx cdk deploy AgentOsServerless

# --- full-mode store (ADR-0027): Aurora Serverless v2, scale-to-zero — deploy per trip ---
deploy-postgres: whoami ## deploy the full-mode Aurora store (opens 5432 to YOUR current IP)
	cd deploy/aws && bunx cdk deploy AgentOsPostgres -c dbAllowedCidr=$$(curl -s https://checkip.amazonaws.com)/32 --require-approval never

destroy-postgres: ## tear the Aurora store back down (~$$0 idle while paused anyway)
	cd deploy/aws && bunx cdk destroy AgentOsPostgres --force

aurora-bootstrap: ## create the rds_iam DB user (agentos_app) from tracked SQL — run once after deploy-postgres
	cd services/inference-gateway/litellm && uv run python ../../../deploy/aurora/bootstrap.py

postgres-url: ## print the SPEND_DATABASE_URL for the deployed Aurora store
	@SECRET=$$(aws cloudformation describe-stacks --stack-name AgentOsPostgres --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" --output text); \
	 HOST=$$(aws cloudformation describe-stacks --stack-name AgentOsPostgres --query "Stacks[0].Outputs[?OutputKey=='Endpoint'].OutputValue" --output text); \
	 PASS=$$(aws secretsmanager get-secret-value --secret-id $$SECRET --query SecretString --output text | bun -e "const s=JSON.parse(await Bun.stdin.text());console.log(encodeURIComponent(s.password))"); \
	 echo "postgresql://postgres:$$PASS@$$HOST:5432/agentos"

# --- runtime (local process) ---
run: ## run agent-runtime locally (in-memory store)
	SANDBOX_PROVIDER=local bun run services/agent-runtime/server.ts

run-dynamodb: ## run agent-runtime locally against the real DynamoDB table
	RUN_STORE=dynamodb RUNS_TABLE=$(RUNS_TABLE) SANDBOX_PROVIDER=local bun run services/agent-runtime/server.ts

dep-migrator: ## run the dep-migrator agent (local sandbox + Bedrock)
	bun run apps/dep-migrator/migrate.ts

# --- local k8s (colima + k3s) ---
image: ## build the agent-runtime image for k3s
	docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile .

k8s-creds: ## create the aws-creds secret in agent-os from this profile (local only; short-lived for SSO/role)
	kubectl create namespace agent-os --dry-run=client -o yaml | kubectl apply -f -
	@eval "$$(aws configure export-credentials --format env-no-export)"; \
	  args="--from-literal=AWS_ACCESS_KEY_ID=$$AWS_ACCESS_KEY_ID --from-literal=AWS_SECRET_ACCESS_KEY=$$AWS_SECRET_ACCESS_KEY"; \
	  [ -n "$$AWS_SESSION_TOKEN" ] && args="$$args --from-literal=AWS_SESSION_TOKEN=$$AWS_SESSION_TOKEN"; \
	  kubectl -n agent-os create secret generic aws-creds $$args --dry-run=client -o yaml | kubectl apply -f -

k8s-deploy: ## deploy the platform apps via Helm (deploy/helm/agent-os) into agent-os
	helm upgrade --install agent-os deploy/helm/agent-os -n agent-os --create-namespace
	kubectl -n agent-os rollout status deploy/agent-runtime

k8s-logs: ## tail the runtime logs
	kubectl -n agent-os logs -f deploy/agent-runtime

k8s-forward: ## port-forward the runtime to localhost:3000
	kubectl -n agent-os port-forward svc/agent-runtime 3000:80

gw-image: ## build the Bun inference-gateway image for k3s (ADR-0028)
	docker build -t inference-gateway:dev -f services/inference-gateway/Dockerfile .

gw-deploy: ## deploy the Bun gateway via Helm (deploy/helm/inference-gateway) into agentos-gw
	helm upgrade --install inference-gateway deploy/helm/inference-gateway -n agentos-gw --create-namespace
	kubectl -n agentos-gw rollout status deploy/inference-gateway

gw-pod-test: ## prove the gateway pod end to end: real SA token → TokenReview → claim → 402 (no AWS, $0)
	bash deploy/local/gateway-pod-test.sh

gw-mesh-test: ## prove full-mode mesh-trust on the Bun gateway: token-less caller, Linkerd-stamped identity → claim → 402
	bash deploy/local/gateway-mesh-test.sh

sandbox-test: ## deploy deploy/helm/sandbox + prove egress lockdown (wall + allowlist), then tear down
	bash deploy/local/sandbox-test.sh

gate-conformance: ## assert the gate contract (R1+R2) holds identically on both gateways (ADR-0027)
	bash deploy/local/gate-conformance.sh

local-full: ## run the WHOLE-platform local e2e — everything on, one governed run (the anchor)
	bash deploy/local/run.sh local-full

local: ## list all local e2e scenarios (then: bash deploy/local/run.sh <id>)
	@bash deploy/local/run.sh

# --- test agents (exercise the platform end-to-end) ---
spine-agent: ## run the spine test agent through the live gateway (small Bedrock spend)
	bash examples/spine-agent/run.sh

coding-agent: ## run the coding agent end-to-end — think governed, code in the sandbox
	bash examples/coding-agent/run.sh

coding-agent-pod: ## Model A in k3s: coding agent as a pod BEHIND the egress wall (think governed, do contained)
	bash deploy/local/sandbox-coding-agent.sh

.PHONY: help whoami bootstrap synth diff deploy destroy outputs deploy-postgres destroy-postgres aurora-bootstrap postgres-url run run-dynamodb dep-migrator image k8s-creds k8s-deploy k8s-logs k8s-forward gw-image gw-deploy gw-pod-test gw-mesh-test sandbox-test gate-conformance spine-agent coding-agent coding-agent-pod

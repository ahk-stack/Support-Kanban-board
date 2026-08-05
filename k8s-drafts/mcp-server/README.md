# mcp-server K8s manifests (draft)

These are **drafts**, not live cluster config. The actual cluster manifests
live on the `gitops` branch, which is auto-updated by the Bamboo pipeline
(image-tag bump commits) - I intentionally did not commit anything there
myself. This folder is just a ready-to-adapt starting point for Wajdi.

## What Wajdi needs to do

1. **New Bamboo build plan** producing `qtk8s.azurecr.io/support-kanban-mcp_code:<tag>`
   from `docker/mcp-server.Dockerfile` with build context `mcp-server/` (see
   the repo root for both).
2. Copy `deployment.yaml`, `service.yaml`, `ingress.yaml` from this folder
   into `gitops`'s `k8s/preprod/` (or wherever the pipeline expects them),
   swapping the placeholder image tag for whatever the new build plan
   produces, and let the existing image-tag-bump automation take over from there.
3. Make sure `mcp.support-preprod.gotogo.im` resolves the same way
   `support-preprod.gotogo.im` does (same ingress controller / DNS zone -
   the Ingress below assumes `cert-manager` + `nginx` are already set up
   exactly as they are for the main app).

## Design notes

- **No Secret, no DB, no init containers.** The MCP server has no identity
  or storage of its own - every request just forwards the caller's own
  Bearer token straight to the main app's `/api/mcp/*` routes. Only a
  ConfigMap (`KANBAN_API_BASE`, `PORT`) is needed.
- `KANBAN_API_BASE` points at the **in-cluster** `support-kanban` Service
  (`http://support-kanban`, ClusterIP, ie its Service definition port 80),
  not the public `https://support-preprod.gotogo.im` host - that avoids an
  unnecessary hairpin back out through the ingress/TLS termination for
  what's really just server-to-server traffic inside the cluster.
- Resource requests/limits are intentionally small (a stateless pass-through
  proxy, not the main app) - tune if real usage says otherwise.
- Liveness/readiness both hit `/healthz` (added in `mcp-server/index.js`).

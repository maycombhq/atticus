# 0024. Platform extractors: OpenShift, GCP, pipelines, access, batch

- Status: accepted
- Date: 2026-10-18

## Decision

Five built-in extractors read platform files (`openshift`, `gcp`, `pipelines`, `access`, `batch`, all 0.1.0), with a tolerant HCL reader and a multi-document YAML reader that keeps line numbers. OpenShift Templates are filled in with their parameter defaults; Helm charts are skipped because they need rendering. Environments come from the namespace, then an environment folder (`overlays/prod`), then the name. A Kubernetes Deployment the infra extractor already reads keeps its id, so the records merge.

Where C1 has no field, the fact becomes a config Setting: an OpenShift Route is `route.<name>` with its public URL, a batch schedule `schedule.<job>` with the cron expression (time zone as a `CRON_TZ=` prefix); settings for one environment have ids `<component>.<env>.<key>`. Pipelines from Azure Pipelines, GitHub Actions, GitLab CI and Jenkins are normalised into QualityAssets with stages, triggers, environments, deploy targets and test steps. Access facts become AccessGrants: Kubernetes RBAC subjects with their role rules, Terraform IAM for service accounts and groups, API products as roles. Users and emails are never recorded.

## Consequences

Deployments, schedules, pipelines and grants become catalog records with provenance; the Forge scan is unchanged. Candidate additive C1 changes for later: `Setting.settingKind: schedule`, and a field or kind for ingress hosts.

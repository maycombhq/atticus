# 0056. Dialect rules v2: conditions, Terraform blocks, skips, receiver types and coverage

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

Dialects (contract C2) teach the scanner a house framework without code. Trying them on a customised estate showed five gaps:

- **No conditions.** A rule matches every annotation, call or key of its kind; the only way to narrow it is a file glob (`*Api.java`). Infra repos need more: a Terraform `module` block is a house topic only when its `source` is the house topic module.
- **No Terraform.** Infra and pipeline repos declare what a house platform provisions in structured files. YAML, JSON and XML have matches (`jsonPath`, `xpath`, `configKey`); HCL has none, so a house Terraform module can be read only with a `regex`.
- **A template that can't be filled makes an invalid record.** A rule whose `pathOrTopic` comes from a variable that isn't set produces a record that fails C1, which fails the dialect's tests, or, in a real repo, is rejected with an error that names the record rather than the reason.
- **`receiverType` is ignored.** It is accepted and documented but the engine never checks it, so `send` with `receiverType: AuditPublisher` matches every `send` call. A rule that says less than it claims is worse than no rule.
- **The test gate doesn't check coverage.** A dialect passes when its tests pass, even if no test exercises half its rules. An assistant-drafted rule can go untested.

## Decision

**Contract C2, additions** (optional, ADR 0041's rule; `schemaVersion` stays 1 and every existing dialect stays valid):

- **`where`** on a rule: a list of conditions, all of which must hold for a match to emit. Each is `{ value: <template>, matches: <regex> }`; a value that can't be filled fails its condition. `where: [{ value: "${attr.source}", matches: "tide-kafka-topic" }]`.
- **`hclBlock` match**: `{ hclBlock: module, files: ["**/*.tf"] }` matches every block of that type (`resource.aws_sqs_queue` also requires the first label). `${attr.x}` is the block's attribute `x`, resolved from the folder's variable defaults, `terraform.tfvars`, `*.auto.tfvars` and locals the way the built-in Terraform reader does; an attribute of a nested block is `${attr.block.x}`. `${match.0}` is the block's last label (its name) and `${match.1}`... its labels in order. A value that still holds `${...}` after resolving is not set.

**Engine changes:**

- A record a template can't complete (a field C1 requires was not filled) is **skipped with a warning** naming the rule and the fields, instead of being emitted invalid. `atticus dialect run` shows the warning. A record that is invalid for any other reason is still rejected.
- **`receiverType` is applied** to Java and Kotlin `methodCall` matches: the receiver must be a field, parameter or variable declared with that type (simple name; generics allowed), or the type itself for a static call.
- **Every rule must be exercised**: a dialect's own rules (not ones it inherits) must each produce at least one record in at least one test, or `atticus dialect test` fails, and a scan doesn't use the dialect. Shipped dialects meet it.

The `plugin:` field stays declared but not loaded; loading org-pack code is a security decision for the install and security phase.

## Consequences

- Infra and pipeline repos are read through dialects: house Terraform modules with `hclBlock` and `where`, Helm values, pipelines and descriptors with `jsonPath`. The framework model (ADR 0054, 0055) stays for code.
- Rules can be narrow and honest. An assistant drafting a dialect with the kit can't leave a rule untested.
- A dialect that relied on `receiverType` being ignored now matches less; that was the documented meaning.

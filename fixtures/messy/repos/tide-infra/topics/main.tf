# Topics are provisioned through the platform team's house module, never the provider directly.
module "card_statements" {
  source     = "git::https://git.tide.internal/platform/tide-kafka-topic.git?ref=v2.1.0"
  name       = "cards.statements.${var.env}"
  owner_team = local.cards
  partitions = 12
}

module "limit_changes" {
  source     = "git::https://git.tide.internal/platform/tide-kafka-topic.git?ref=v2.1.0"
  name       = "web.limits.${var.env}"
  owner_team = "web-bff"
}

# Not a topic: a public module, which the dialect's condition leaves alone.
module "network" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "tide-core"
}

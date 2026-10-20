# Two instantiations of the local queue module, and two remote modules a dialect can match.
variable "env" {
  default = "dev"
}

module "orders_queue" {
  source = "../../modules/queue"
  name   = "orders"
  env    = var.env
}

module "payments_queue" {
  source = "../../modules/queue/"
  name   = "payments"
  env    = var.env
}

# A value the caller can't resolve: the module's resources that need it are skipped.
module "mystery_queue" {
  source = "../../modules/queue"
  name   = data.external.queue.result
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "core"
}

module "events_topic" {
  source = "git::https://git.forge.internal/platform/forge-topic.git?ref=v1"
  name   = "events.${var.env}"
}

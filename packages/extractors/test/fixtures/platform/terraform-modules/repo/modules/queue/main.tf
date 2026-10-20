# Forge's house queue module (invented): a topic, a queue, a state table and a dead-letter queue.
variable "name" {
  type = string
}

variable "env" {
  type    = string
  default = "dev"
}

locals {
  full = "${var.name}-${var.env}"
}

resource "aws_sns_topic" "this" {
  name = local.full
}

resource "aws_sqs_queue" "this" {
  name = "${var.name}-queue"
}

resource "aws_dynamodb_table" "state" {
  name = "${local.full}-state"
}

module "dlq" {
  source = "../dlq"
  name   = "${var.name}-dlq"
}

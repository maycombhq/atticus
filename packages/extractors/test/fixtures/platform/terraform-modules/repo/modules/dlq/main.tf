variable "name" {
  type = string
}

resource "aws_sqs_queue" "dlq" {
  name = var.name
}

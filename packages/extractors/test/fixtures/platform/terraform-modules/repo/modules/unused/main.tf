# No folder calls this module: it is read on its own, with its defaults, as before.
variable "name" {
  default = "spare"
}

resource "aws_sqs_queue" "spare" {
  name = "${var.name}-queue"
}

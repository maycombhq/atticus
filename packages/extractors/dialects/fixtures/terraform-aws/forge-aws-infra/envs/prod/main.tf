# Forge's AWS estate (invented), prod. One resource of each type the terraform-aws dialect reads,
# and some it leaves to built-in readers (S3, SQS) or to no record at all (the EKS cluster).

locals {
  prefix = "forge"
}

# ---- messaging
resource "aws_sns_topic" "order_events" {
  name = "${local.prefix}-order-events-${var.env}"
}

resource "aws_cloudwatch_event_bus" "payments" {
  name = "forge-payments"
}

resource "aws_msk_cluster" "events" {
  cluster_name  = "forge-events"
  kafka_version = "3.6.0"
}

resource "kafka_topic" "orders_placed" {
  name               = "orders.placed"
  partitions         = 6
  replication_factor = 3
}

# Read by the cloud-stores extractor, not by the dialect.
resource "aws_sqs_queue" "invoices" {
  name = "forge-invoices"
}

# ---- compute
resource "aws_lambda_function" "invoice" {
  function_name = "invoice-renderer"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  tags = {
    env = var.env
  }
}

resource "aws_ecs_service" "checkout" {
  name          = "checkout-svc"
  desired_count = 3
  tags = {
    env = var.env
  }
}

# A cluster is where deployments run, not a record of its own.
resource "aws_eks_cluster" "main" {
  name = "forge-prod"
}

# ---- data
resource "aws_dynamodb_table" "carts" {
  name     = "forge-carts"
  hash_key = "id"
}

resource "aws_db_instance" "orders" {
  identifier = "orders-db"
  engine     = "postgres"
}

resource "aws_db_instance" "sessions" {
  identifier = "sessions-db"
  engine     = "mysql"
}

resource "aws_db_instance" "billing" {
  identifier = "billing-db"
  engine     = "sqlserver-se"
}

resource "aws_db_instance" "erp" {
  identifier = "erp-db"
  engine     = "oracle-ee"
}

resource "aws_rds_cluster" "ledger" {
  cluster_identifier = "ledger-cluster"
  engine             = "aurora-postgresql"
}

resource "aws_rds_cluster" "carts" {
  cluster_identifier = "carts-cluster"
  engine             = "aurora-mysql"
}

resource "aws_rds_cluster" "audit" {
  cluster_identifier = "audit-cluster"
  engine             = "aurora"
}

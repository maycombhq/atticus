variable "env" {
  default = "prod"
}

resource "aws_s3_bucket" "media" {
  bucket = "shop-media-${var.env}"
}

resource "aws_sqs_queue" "dlq" {
  name = "shop-dlq"
}

resource "aws_redshift_cluster" "dw" {
  cluster_identifier = "shop-warehouse"
}

resource "aws_elasticache_replication_group" "sessions" {
  replication_group_id = "shop-sessions"
}

resource "google_storage_bucket" "exports" {
  name = "shop-exports"
}

resource "aws_instance" "web" {
  ami = "ami-0123"
}

resource "aws_s3_bucket" "media" {
  bucket = "harbor-media"
}

resource "aws_sqs_queue" "webhook_dlq" {
  name                      = "harbor-webhook-dlq"
  message_retention_seconds = 1209600
}

resource "aws_elasticache_replication_group" "features" {
  replication_group_id = "harbor-features"
  description          = "Feast online store for the recommendations model"
  engine               = "redis"
  node_type            = "cache.r7g.large"
}

resource "aws_db_instance" "orders" {
  identifier     = "orders-db"
  engine         = "postgres"
  engine_version = "16.4"
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

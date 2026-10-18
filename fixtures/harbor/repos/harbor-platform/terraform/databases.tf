resource "aws_db_instance" "orders" {
  identifier        = "orders-db"
  engine            = "postgres"
  engine_version    = "16.4"
  instance_class    = "db.r6g.large"
  allocated_storage = 200
  multi_az          = true
}

resource "aws_db_instance" "catalog" {
  identifier        = "catalog-db"
  engine            = "postgres"
  engine_version    = "16.4"
  instance_class    = "db.r6g.large"
  allocated_storage = 100
  multi_az          = true
}

resource "aws_redshift_cluster" "warehouse" {
  cluster_identifier = "harbor-warehouse"
  database_name      = "analytics"
  node_type          = "ra3.xlplus"
  number_of_nodes    = 2
}

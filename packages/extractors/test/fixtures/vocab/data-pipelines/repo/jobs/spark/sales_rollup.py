from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()
orders = spark.read.table("raw.orders")
stock = spark.table("raw.stock")
orders.join(stock, "sku").write.mode("overwrite").saveAsTable("mart.sales_rollup")

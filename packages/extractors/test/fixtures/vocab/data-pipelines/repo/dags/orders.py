from datetime import datetime

from airflow import DAG
from airflow.decorators import dag
from airflow.providers.common.sql.operators.sql import SQLExecuteQueryOperator

with DAG(dag_id="nightly_orders", schedule="0 2 * * *", start_date=datetime(2026, 1, 1)) as d:
    load = SQLExecuteQueryOperator(
        task_id="load",
        sql="INSERT INTO mart.daily_orders SELECT * FROM raw.orders",
    )


@dag(schedule_interval="@hourly", start_date=datetime(2026, 1, 1))
def refresh_stock():
    pass

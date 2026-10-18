from datetime import datetime

from airflow import DAG
from airflow.operators.bash import BashOperator

with DAG(
    dag_id="orders_daily",
    schedule="0 3 * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["warehouse"],
) as dag:
    build = BashOperator(task_id="dbt_build", bash_command="dbt build --project-dir /opt/harbor/dbt")
    features = BashOperator(
        task_id="feast_materialize",
        bash_command="feast -c /opt/harbor/features materialize-incremental {{ ds }}",
    )
    build >> features

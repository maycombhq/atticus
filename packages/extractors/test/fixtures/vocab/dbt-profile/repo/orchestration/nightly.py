from airflow import DAG
from airflow.operators.bash import BashOperator

with DAG(dag_id="nightly_build", schedule="0 4 * * *") as dag:
    BashOperator(task_id="build", bash_command="dbt build --project-dir /opt/shop/dbt")

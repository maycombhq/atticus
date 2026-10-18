resource "aws_sagemaker_endpoint" "churn" {
  name                 = "churn-model"
  endpoint_config_name = aws_sagemaker_endpoint_configuration.churn.name
}

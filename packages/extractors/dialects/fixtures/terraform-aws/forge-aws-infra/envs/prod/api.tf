# The shop's HTTP API (API Gateway v2) and the partner REST API (v1).
resource "aws_apigatewayv2_api" "shop" {
  name          = "shop-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_route" "list_orders" {
  api_id    = aws_apigatewayv2_api.shop.id
  route_key = "GET /orders"
}

resource "aws_apigatewayv2_route" "place_order" {
  api_id    = aws_apigatewayv2_api.shop.id
  route_key = "POST /orders"
}

# The catch-all route has no path: no route record.
resource "aws_apigatewayv2_route" "fallback" {
  api_id    = aws_apigatewayv2_api.shop.id
  route_key = "$default"
}

resource "aws_api_gateway_rest_api" "partners" {
  name = "partner-api"
}

resource "aws_api_gateway_resource" "quotes" {
  rest_api_id = aws_api_gateway_rest_api.partners.id
  parent_id   = aws_api_gateway_rest_api.partners.root_resource_id
  path_part   = "quotes"
}

# A nested resource: its full path needs the parent chain, which a rule can't follow.
resource "aws_api_gateway_resource" "quote" {
  rest_api_id = aws_api_gateway_rest_api.partners.id
  parent_id   = aws_api_gateway_resource.quotes.id
  path_part   = "{id}"
}

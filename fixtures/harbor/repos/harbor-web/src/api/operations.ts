// GraphQL operations the web shop sends to the Shop Graph (schema: harbor-graph/schema/shop.graphql).

export const PRODUCT_LIST = /* GraphQL */ `
  query ProductList($first: Int!) {
    products(first: $first) {
      id
      name
      priceCents
    }
  }
`;

export const PRODUCT_PAGE = /* GraphQL */ `
  query ProductPage($id: ID!) {
    product(id: $id) {
      id
      name
      description
      priceCents
    }
  }
`;

export const RECOMMENDED = /* GraphQL */ `
  query Recommended($customerId: ID!) {
    recommendations(customerId: $customerId, limit: 8) {
      id
      name
    }
  }
`;

export const PLACE_ORDER = /* GraphQL */ `
  mutation PlaceOrder($input: PlaceOrderInput!) {
    placeOrder(input: $input) {
      id
      status
    }
  }
`;

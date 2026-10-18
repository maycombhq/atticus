// Operations the mobile app sends to the Shop Graph.

export const BROWSE = `
  query Browse($first: Int!) {
    products(first: $first) {
      id
      name
      priceCents
      thumbnailUrl
    }
  }
`;

export const ORDER_STATUS = `
  query OrderStatus($id: ID!) {
    order(id: $id) {
      id
      status
      totalCents
    }
  }
`;

export const CHECKOUT = `
  mutation Checkout($input: PlaceOrderInput!) {
    placeOrder(input: $input) {
      id
      status
    }
  }
`;

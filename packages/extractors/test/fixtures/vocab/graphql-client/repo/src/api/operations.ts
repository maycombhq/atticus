// A template with the GraphQL hint comment but no tag.
export const ORDERS = /* GraphQL */ `
  query Orders($first: Int!) {
    orders(first: $first) { id }
  }
`;

// A plain template that opens with an operation header.
export const CHECKOUT = `
  mutation Checkout($input: CheckoutInput!) @retry {
    checkout(input: $input) { id }
  }
`;

// Prose and log messages that start with the word query are not operations.
export const failed = (id: string) => `query failed for ${id}`;
export const slow = (id: string) => `query ${id} {took long}`;

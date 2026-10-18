import { gql, useQuery, useSubscription } from "@apollo/client";

const CART = gql`
  query Cart {
    cart { items { sku } }
    stock(sku: "abc") { level }
  }
`;

const LIVE = gql(`
  subscription { reviewAdded { id } }
`);

export function useCart() {
  // fetch("/legacy") is not GraphQL
  useSubscription(LIVE);
  return useQuery(CART);
}

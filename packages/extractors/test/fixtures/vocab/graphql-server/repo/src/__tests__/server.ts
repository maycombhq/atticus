import gql from "graphql-tag";

// Tests are never read.
export const Q = gql`
  query {
    adminOnly
  }
`;

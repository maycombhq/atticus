import { ApolloServer } from "@apollo/server";
import gql from "graphql-tag";

// const old = gql`type Query { legacy: String }`;
export const typeDefs = gql`
  type Query {
    categories: [Category!]!
  }
  type Category {
    id: ID!
  }
`;

export const server = new ApolloServer({ typeDefs });

// Deliberately non-conforming: an id that isn't a slug, a version that isn't semver, no claims.
export const extractor = {
  id: "Bad_Id",
  version: "one",
  claims: [],
  async *scan() {},
};

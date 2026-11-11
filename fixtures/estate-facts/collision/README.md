# Two repos with a component of the same name (B-fixes, problem 1)

Two invented Forge repos read by the assistant, each with a `frontend` component (a common name
for a monorepo's front-end folder), and one component whose name is its own. Written one by one
with the other's facts as the estate (`catalogWithFacts`), each repo keeps its own `frontend`:
the colliding components get the repo's id in front (`forge-shop-frontend`,
`forge-admin-frontend`), and `forge-admin`'s `admin-api` keeps its id. The manifest lists each
repo's modules (review of beta.25): a repo whose entry lists none ships as its one component, and
a fact naming a component the manifest doesn't is placed in it.

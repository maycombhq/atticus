/**
 * F5: repo ids that do not drift. Moved to @maycombhq/workspace in review round 50, so repos
 * discover (in @maycombhq/adopt) tells the same repo from an id clash the way repo add does.
 */
export {
  cloneUrlKey,
  nearRepos,
  repoIdKey,
  SAME_ID_WHY,
  type NearRepo,
} from "@maycombhq/workspace";

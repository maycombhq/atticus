# SSO notes for Forge services

## Steps

1. Register the service as a client in Forge Identity.
2. Set the redirect URI to /sso/callback.
3. Check each token's signature before trusting its claims.

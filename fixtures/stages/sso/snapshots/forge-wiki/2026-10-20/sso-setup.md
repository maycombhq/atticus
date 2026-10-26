# Set up SSO for a Forge service

## Steps

1. Register the service as a client in Forge Identity and note its client id.
2. Set the redirect URI to /login/oauth2/code/forge-identity.
3. Read the client secret from the Forge vault at start-up, never from a file in the repo.
4. Check the signature of every token against the Forge Identity keys before reading its claims.

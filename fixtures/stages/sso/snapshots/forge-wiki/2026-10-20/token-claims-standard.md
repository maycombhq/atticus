# Token claims standard

## Required claims

A service that accepts Forge SSO tokens refuses a token whose aud claim doesn't name the service.

A service reads who the caller is from the sub and email claims, never from a request header.

# Experience APIs at Forge

An experience API is the one server-side component a channel owns. It exists to shape and
aggregate the domain services' APIs for that channel's screens: a `GET /v1/home` that fans out to
orders, stock and payments and returns one document.

## Conventions

- One experience API per channel (web, mobile, partner); never shared between channels.
- Built on `@forge/experience-kit`: routing, sign-on and the gateway client come from the kit.
- Calls go through the Forge gateway (`forge-gateway`), with the channel's client id.

## Review questions

- Does it hold data? If so it is a service, not an experience API.
- Does it call a vendor directly? Move the call behind a domain service.

# The messy estate (fixture)

An invented bank, Tidewater, whose teams write code the way real ones do: no literal URLs or topics, base URLs from `@Value` and profile config, house starters with their own annotations and wrapper clients, Kotlin next to Java, JMS as well as Kafka, a password in a datasource URL, a template file that doesn't parse, and a gateway whose host has to be declared. Nothing here is real.

It is the phase 2 gate (`packages/scanner/test/messy.test.ts`): a scan finishes, makes no verified fact the code doesn't spell out, shows every client call it found (joined or as a loose end), joins through the gateway only on its declared host, keeps no secret, and reports its coverage. What a scan can't read yet (the house annotation and the wrapper client) is listed in the test as a known gap for phase 3, so the test turns red the day it is fixed.

| Repo | What it has |
| --- | --- |
| `tide-cards` | Controllers on constants, a house-annotated controller, a Kotlin controller, `@Value` base URL + constant path, a partner call on the gateway's basepath, a `/health` poll, Kafka on a constant topic, JMS, a wrapper client, a broken template file, profile config with a password in the datasource URL |
| `tide-payments` | `POST /v2/payments` and `GET /health` |
| `tide-gateway` | An Apigee proxy `/payments-api` to `payments.tide.internal`, on the declared host `api-gw.tide.internal` |

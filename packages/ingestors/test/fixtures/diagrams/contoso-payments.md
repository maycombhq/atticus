# Contoso payments

The team keeps this diagram as code next to the services.

```mermaid
graph TD
  %% a comment line
  subgraph pay[Payments]
    api[Pay API]
    worker([Settlement<br/>Worker]):::retire
  end
  web{{Web Shop}} --> api & worker
  api == S.GW.VND POST /v1/charge ==> fab[(Fabrikam Gateway)]
  worker --> |settlement.done| queue@{ shape: cyl, label: "Settlement Queue" } --> api
  api --- pay
  this line is not mermaid
  class fab new
```

Text after the diagram.

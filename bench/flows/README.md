# Reference flows

Hand-written flows for the bench's connected estates (revamp plan 4.2 and Phase 1, P1.3): what happens, step by step, when something enters a repo, across repos, with the data at each step. Written by reading the code at the pinned commits in `../repos.yaml`, never from a scan. They are the yardstick for Phase 2b's repo specs and Phase 3's estate pass, and the first concrete shape of the `Flow` record (section 5 of the plan): when that record is designed, these files show what it must hold.

One file per estate: `<estate>.yaml`.

```yaml
estate: petclinic
repos: [spring-petclinic-angular, spring-petclinic-rest]
notes: >-
  Judgement calls, what was left out and why.
flows:
  - id: add-owner
    name: A person adds a pet owner
    trigger:
      kind: action # endpoint | action (a button or form in a UI) | page (a page load) | listener | job
      repo: spring-petclinic-angular
      what: The Add Owner form is submitted
      at: "src/app/owners/owner-add/owner-add.component.ts:52"
    steps:
      - kind: call-out
        repo: spring-petclinic-angular
        what: POST /petclinic/api/owners with the form's fields
        to: { repo: spring-petclinic-rest, entry: "POST /petclinic/api/owners" }
        data: { sends: [firstName, lastName, address, city, telephone] }
        at: "src/app/owners/owner.service.ts:61"
      - kind: entry
        repo: spring-petclinic-rest
        what: OwnerRestController.addOwner receives the owner
        at: "src/main/java/.../OwnerRestController.java:70"
      - kind: transform
        repo: spring-petclinic-rest
        what: The DTO becomes an Owner entity
        data: { from: [OwnerFieldsDto.firstName, ...], to: [Owner.firstName, ...] }
        at: "..."
      - kind: write
        repo: spring-petclinic-rest
        what: The owner is inserted
        store: { table: owners, fields: [first_name, last_name, address, city, telephone] }
        at: "..."
      - kind: respond
        repo: spring-petclinic-rest
        what: 201 Created with the saved owner and a Location header
        data: { returns: [id, firstName, lastName, address, city, telephone, pets] }
        at: "..."
    errors:
      - { when: The fields fail validation, then: 400 with the errors, at: "..." }
```

Step kinds: `entry`, `lookup` (a read to decide something), `read`, `write`, `call-out`, `publish`, `transform`, `validate`, `branch`, `log` (log or audit), `respond`, `loop`, `retry`. Every step has `repo`, `what` (one plain sentence) and `at` (path:line in that repo). `data` names fields as the code names them (`sends`, `returns`, `from` and `to` for a transform, `reads` for the fields a step looks at, `checks` for the rules a validation applies); `store` names the table and columns as the database does. A call-out names the repo and entry point it reaches, which is how a flow crosses repos.

Pick the flows a person would draw on a whiteboard to explain the estate: the main journeys, each followed end to end, not every endpoint.

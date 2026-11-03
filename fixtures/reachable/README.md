# Reachable-first reading of model classes (ADR 0169)

Two invented Forge services for the planner's reachability tests:

- `forge-house/` (Java, Spring): `HouseController` takes a `ListingRequest` (which nests an
  `Address`) and returns a `ValuationResponse`, which `ValuationClient` posts and receives. Five
  more model classes (`AgentProfile`, which nests `OpenHouseSlot`, `LegacyListing`,
  `MortgageQuote`, which only a service names, and `InspectionReport`) are reached by no entry
  point or call.
- `forge-appraise/` (Python, FastAPI and pydantic), the second stack: the router takes an
  `AppraisalRequest` (which nests a `Parcel`) and answers an `AppraisalResult`, which
  `CountyClient` receives; `ZoningNote` and `SurveyRecord` are reached by nothing.

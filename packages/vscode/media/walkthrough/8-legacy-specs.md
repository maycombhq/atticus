# Legacy: draft the specs

`atticus spec draft` is a legacy command: map and verify give each repo's flows now, every step citing its line.

A repo's spec is its flows: what happens, step by step, when something starts one. **Draft a spec** writes them with Copilot from a scan, and Atticus checks every step against its cited line.

See a repo's flows on the app's **Map**, as diagrams. In the code, a line above each cited line says which step cites it; click it to open the flow beside the code. (With the setting `atticus.fullUi`, the **Repos** section lists them too.)

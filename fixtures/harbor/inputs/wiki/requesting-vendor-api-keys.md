# How to request a vendor API key

Harbor services never hold a SaaS vendor's API key in code or config. Keys live in Vault and reach the egress gateway, which adds them to calls that match the vendor allow-list.

1. Open a GitHub issue in harbor/harbor-platform with the label `vendor-key`. Fields: vendor, environment (sandbox or production), calling service, expected calls per minute, data classification, approver (the vendor's business owner).
2. The platform team asks the vendor for the key and stores it under `vault:<team>/<vendor>-api-key`.
3. The platform team adds the vendor host to the egress allow-list and names the Vault path in the egress route.

Typical lead time: 5 working days for sandbox keys, 15 working days for production keys (the vendor's own review).

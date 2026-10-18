# Mappings

## POST /orders/{id}/gift-card

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| input.code | code | as is, upper case | GIFT_CARD_INVALID |
| order id | id | as is | 404 |

## POST /gift-cards/redeem

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| code | code | as is | refuse the order |
| order total in cents | maxAmountCents | as is | refuse the order |

## POST /v1/gift-cards/{code}/redeem

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| maxAmountCents | amount | as is | refuse the order |
| order id | reference | as is | refuse the order |

## POST /v1/charges

No mapping change: amount is the order total minus what the card paid.

## GET /carts/abandoned

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| unused gift card balance | giftCardBalanceCents | as is | 0 |

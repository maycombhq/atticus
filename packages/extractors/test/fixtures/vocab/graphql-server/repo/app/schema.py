import strawberry


@strawberry.type
class Query:
    best_sellers: list[str]

    @strawberry.field
    def gift_cards(self) -> list[str]:
        return []

    def _helper(self):  # not a field
        return None


@strawberry.type
class Mutation:
    @strawberry.mutation
    def redeem_gift_card(self, code: str) -> bool:
        return True

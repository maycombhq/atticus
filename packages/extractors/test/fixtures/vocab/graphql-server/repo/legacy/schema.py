import graphene


class Query(graphene.ObjectType):
    store_hours = graphene.String(day=graphene.String())

    def resolve_store_hours(self, info, day):
        return "9-5"

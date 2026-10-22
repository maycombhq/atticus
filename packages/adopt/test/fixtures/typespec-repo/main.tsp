import "@typespec/http";
import "./models/price.tsp";

using TypeSpec.Http;

@service(#{ title: "Northwind Pay pricing" })
@server("https://pricing.northwind.example", "Pricing")
namespace NorthwindPay.Pricing;

@route("/prices")
interface Prices {
  @get list(): Price[];
  @get read(@path id: string): Price | NotFound;
  @post create(@body price: Price): Price;
}

@route("/quotes")
op quote(@body request: QuoteRequest): Quote;

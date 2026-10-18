import { Controller, Get, Query } from "@nestjs/common";
import { OrdersService } from "./orders.service";

/** Carts left without an order: read by the cart reminder function every two hours. */
@Controller("carts")
export class CartsController {
  constructor(private readonly orders: OrdersService) {}

  @Get("abandoned")
  abandoned(@Query("olderThanMinutes") olderThanMinutes = "120") {
    return this.orders.abandonedCarts(Number(olderThanMinutes));
  }
}

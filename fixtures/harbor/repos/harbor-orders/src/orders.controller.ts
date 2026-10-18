import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { OrdersService, type PlaceOrder } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  place(@Body() body: PlaceOrder) {
    return this.orders.place(body);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.orders.find(id);
  }
}

import { Module } from "@nestjs/common";
import { CartsController } from "./carts.controller";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  controllers: [OrdersController, CartsController],
  providers: [OrdersService],
})
export class AppModule {}

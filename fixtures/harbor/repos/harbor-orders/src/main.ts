import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { startPaymentListener } from "./events";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await startPaymentListener();
  await app.listen(3000);
}

void bootstrap();

package forge.orders;

import forge.messaging.*;

// Test-only handler: production records come from src/main/java only.
public class OrderHandlersTest {

  @OnMessage(channel = "test.orders", group = "test")
  public void captures(Object message) { }
}

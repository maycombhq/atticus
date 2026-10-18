// Callbacks this service asks payment and shipping partners to send.
export async function register() {
  await fetch("https://api.northwind-pay.example/v1/webhooks", {
    method: "POST",
    body: JSON.stringify({
      url: "https://orders.harbor.example/hooks/payments",
      events: ["payment.succeeded"],
    }),
  });
  await contoso.webhooks.register({ webhookUrl: "https://orders.harbor.example/hooks/contoso" });
  // A link that isn't a registration is not read:
  const docs = { url: "https://docs.harbor.example/orders" };
  return docs;
}

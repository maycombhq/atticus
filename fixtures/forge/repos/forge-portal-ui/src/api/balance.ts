// Calls the portal BFF for an account balance.
export async function getBalance(accountId: string) {
  const res = await fetch(`/api/balance/${accountId}`, { method: "GET" });
  return res.json();
}

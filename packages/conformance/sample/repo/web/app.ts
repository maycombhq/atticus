export async function balance(id) {
  const res = await fetch(`https://ledger.sample.example/accounts/${id}/balance`);
  return res.json();
}

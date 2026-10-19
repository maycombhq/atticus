import { lantern } from "@tide/lantern/server";

export async function statementFor(req: { params: { id: string } }) {
  return lantern.call("cards", "GET", `/statements/${req.params.id}`);
}

export async function raise(req: { body: { amount: number } }) {
  return { accepted: req.body.amount <= 1000 };
}

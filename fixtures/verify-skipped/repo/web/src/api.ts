import { client } from "./client";
import type { Wallet } from "@forge/wallet-types";

export const getWallet = (id: string) => client.get<Wallet>(`/api/wallets/${id}`);
// export const old = () => client.get("/api/wallets/old");
export const freeze = (id: string) => client.post(`/api/wallets/${id}/freeze`);
const logo = "/assets/logo.svg";

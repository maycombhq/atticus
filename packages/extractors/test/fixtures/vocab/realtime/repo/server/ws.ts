import { WebSocketServer } from "ws";

export const wss = new WebSocketServer({ port: 8081, path: "/prices" });

import { Server } from "socket.io";

export const io = new Server(httpServer(), { path: "/rt" });
export const orders = io.of("/orders");
function httpServer() {}

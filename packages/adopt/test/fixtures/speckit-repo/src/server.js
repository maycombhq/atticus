import express from "express";

const app = express();
app.get("/exports/orders", (_req, res) => res.type("text/csv").send("id,total,currency\n"));
app.listen(8080);

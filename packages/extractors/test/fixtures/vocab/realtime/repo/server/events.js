import express from "express";
const app = express();

app.get("/stream/orders", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.write("data: hi\n\n");
});

app.get("/health", (req, res) => res.send("ok"));

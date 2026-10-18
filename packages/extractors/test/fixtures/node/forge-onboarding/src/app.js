/* eslint-disable */
const express = require("express");
const accounts = require("./routes/accounts");

const app = express();
app.use(express.json());
app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/api/accounts", accounts);
// app.get("/debug/routes", (req, res) => res.json(app._router.stack));
const banner = "try app.get('/not-a-route')";

module.exports = { app, banner };

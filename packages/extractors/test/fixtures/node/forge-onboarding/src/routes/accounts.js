/* eslint-disable */
const { Router } = require("express");
const axios = require("axios");
const { Kafka } = require("kafkajs");

const LEDGER_URL = process.env.LEDGER_URL ?? "http://ledger-api.forge.internal";
const kyc = axios.create({ baseURL: process.env.KYC_URL || "http://localhost:9000" });
const producer = new Kafka({ brokers: ["kafka.forge.internal:9092"] }).producer();

const router = Router();

router.get("/:id", async (req, res) => {
  const balance = await fetch(`${LEDGER_URL}/accounts/${req.params.id}/balance`);
  res.json(await balance.json());
});

router.post("/", async (req, res) => {
  await kyc.post("/checks", { applicant: req.body.applicant });
  await axios.post("http://audit-svc.forge.internal/audit/events", req.body);
  await producer.send({
    topic: "accounts.opened",
    messages: [{ value: JSON.stringify(req.body) }],
  });
  res.status(201).end();
});

module.exports = router;

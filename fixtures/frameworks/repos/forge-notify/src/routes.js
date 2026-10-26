import { Router } from "express";

export const routes = Router();

routes.post("/notices", (req, res) => {
  res.status(202).json({ queued: true });
});

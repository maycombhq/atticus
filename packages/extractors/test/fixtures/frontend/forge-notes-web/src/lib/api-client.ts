import Axios from "axios";
import { env } from "@/config/env";

/** The comments client: every request goes to the API's base. */
export const api = Axios.create({
  baseURL: env.API_URL,
});

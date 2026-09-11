import type { Instrumentation } from "next";
import { reportServerError } from "./src/server/error-monitoring";

export const onRequestError: Instrumentation.onRequestError = (error, _request, context) => {
  reportServerError({ error, context });
};

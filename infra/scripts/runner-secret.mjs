import process from "node:process";
import { setSecret } from "@actions/core";

// Runner command, not application logging. Outside Actions no masking command
// consumer exists, so never print the supplied value to a local terminal.
export function registerRunnerSecret(value) {
  if (process.env.GITHUB_ACTIONS === "true" && typeof value === "string" && value) {
    setSecret(value);
  }
}

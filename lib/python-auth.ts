import crypto from "crypto";
import { env } from "./env";

type PythonServiceAction = "ingest" | "reprocess";

type PythonServiceTokenPayload = {
  action: PythonServiceAction;
  exp: number;
  job_id: string;
};

const TOKEN_TTL_SECONDS = 15 * 60;

export function createPythonServiceToken(jobId: string, action: PythonServiceAction) {
  const payload: PythonServiceTokenPayload = {
    action,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    job_id: jobId
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", env.PYTHON_SERVICE_SHARED_SECRET)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

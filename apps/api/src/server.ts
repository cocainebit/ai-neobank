import { buildApp } from "./app.js";
import { createPostgresStore } from "@ai-neobank/database";
import { parseMasterKey } from "@ai-neobank/signer";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";

const signerMasterKey = process.env.SIGNER_MASTER_KEY ? parseMasterKey(process.env.SIGNER_MASTER_KEY) : undefined;
const signerOptions = signerMasterKey && process.env.ALLOW_SOFTWARE_SIGNERS === "true"
  ? { signerMasterKey, allowSoftwareSigners: true }
  : {};
const app = process.env.DATABASE_URL
  ? buildApp({ store: createPostgresStore(process.env.DATABASE_URL), ...signerOptions })
  : buildApp(signerOptions);
await app.listen({ port, host });

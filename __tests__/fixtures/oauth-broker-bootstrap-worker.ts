import { bootstrapOAuthBroker } from "../../extensions/oauth/broker/bootstrapper.ts";

interface WorkerOptions {
  rootDir: string;
  namespaceId: string;
  requestedPort: number;
  holdMs: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  electionWindowMs: number;
  claimTtlMs: number;
  presencePulseMs: number;
  presenceTtlMs: number;
  idleGraceMs: number;
}

async function main(): Promise<void> {
  const encoded = process.env.OAUTH_BROKER_TEST_OPTIONS;
  if (!encoded) {
    throw new Error("OAUTH_BROKER_TEST_OPTIONS is required.");
  }
  const options = JSON.parse(encoded) as WorkerOptions;
  const result = await bootstrapOAuthBroker(options);
  const health = await result.client.health();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    reused: result.reused,
    requestedPort: result.requestedPort,
    actualPort: result.actualPort,
    endpoint: result.client.endpoint,
    health,
  })}\n`);

  await new Promise(resolve => setTimeout(resolve, options.holdMs));
  await result.client.close();
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error && typeof error === "object" && "code" in error ? error.code : "worker-failed",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});

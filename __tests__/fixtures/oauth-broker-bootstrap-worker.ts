import { bootstrapOAuthBroker } from "../../packages/core/src/oauth/broker/bootstrapper.ts";

interface WorkerOptions {
  rootDir: string;
  namespaceId: string;
  requestedPort: number;
  requestTimeoutMs?: number;
  diagnosticTimeoutMs?: number;
  reconnectIntervalMs?: number;
  presencePulseMs?: number;
  presenceTtlMs?: number;
  idleGraceMs?: number;
  lockStaleMs?: number;
  lockUpdateMs?: number;
  holdMs: number;
}

async function main(): Promise<void> {
  const encoded = process.env.OAUTH_BROKER_TEST_OPTIONS;
  if (!encoded) {
    throw new Error("OAUTH_BROKER_TEST_OPTIONS is required.");
  }
  const options = JSON.parse(encoded) as WorkerOptions;
  const result = await bootstrapOAuthBroker(options);
  await result.client.ensureConnected({ timeoutMs: options.requestTimeoutMs ?? 500 });
  const health = await result.client.health({ timeoutMs: options.requestTimeoutMs ?? 500 });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    spawned: result.spawned,
    reused: result.reused,
    requestedPort: result.requestedPort,
    actualPort: result.actualPort,
    state: result.client.state,
    presenceId: result.client.currentPresenceId,
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

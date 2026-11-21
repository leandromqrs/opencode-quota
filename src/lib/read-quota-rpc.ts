type QuotaRpcRead =
  | { kind: "response"; value: unknown }
  | { kind: "timeout" }
  | { kind: "unavailable" };

export async function readQuotaRpc(
  read: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs = 12_000,
): Promise<QuotaRpcRead> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Quota timeout"));
      }, timeoutMs);
    });
    const value = await Promise.race([read(controller.signal), deadline]);
    return { kind: "response", value };
  } catch {
    return { kind: controller.signal.aborted ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

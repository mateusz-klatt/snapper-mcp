import { createServer } from "node:net";

async function canListenOnLoopback(): Promise<boolean> {
  const server = createServer();

  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export const CAN_LISTEN_ON_LOOPBACK = await canListenOnLoopback();

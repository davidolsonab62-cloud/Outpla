import { io } from "socket.io-client";

export function createSocket(url, token) {
  const socket = io(url, {
    transports: ["polling"],
    upgrade: false,
    path: "/socket.io",
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 2,
    timeout: 3000,
    forceNew: true,
    auth: token ? { token } : undefined,
  });
  return socket;
}

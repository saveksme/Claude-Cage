import { runtimeSocketURL } from "./client-context.mjs";

export function createMacWindowConnection() {
  const socket = new WebSocket(runtimeSocketURL("/macos/claude/connection"));
  const pending = new Map();
  let nextID = 0;
  let closed = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A connection can close before its first request starts waiting.
  ready.catch(() => {});
  const fail = () => {
    closed = true;
    const error = new Error("Соединение с окном виртуального Mac закрыто. Подключитесь заново.");
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener("open", readyResolve);
  socket.addEventListener("error", fail);
  socket.addEventListener("close", fail);
  socket.addEventListener("message", event => {
    try {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      request.resolve(message.result);
    } catch { fail(); socket.close(); }
  });
  return {
    async request(action, fields = {}) {
      await ready;
      if (closed) throw new Error("Соединение с окном виртуального Mac закрыто. Подключитесь заново.");
      const id = ++nextID;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, request: { action, ...fields } }));
      });
    },
    close() { fail(); socket.close(); },
  };
}

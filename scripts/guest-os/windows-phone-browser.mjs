// A dedicated phone-only Node/Chrome subtree. Desktop Chrome and its profile
// are never attached. Public networking is the shared public-only SOCKS proxy.
import path from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { browserExecutable, lines } from "./windows-browser.mjs";

export async function playwrightPhonePipe(chromium, binary, args) {
  const prefix = "--user-data-dir=";
  const directory = args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
  if (!directory || !path.isAbsolute(directory)) throw new Error("Недопустимый каталог данных телефона");
  const filtered = args.filter(arg => !arg.startsWith(prefix) && !["--remote-debugging-pipe", "--headless=new", "about:blank"].includes(arg));
  const context = await chromium.launchPersistentContext(directory, {
    executablePath: binary, headless: true, chromiumSandbox: true,
    args: filtered, ignoreDefaultArgs: ["--enable-automation"],
  });
  let connection;
  try { connection = await context.browser().newBrowserCDPSession(); }
  catch (error) { await context.close(); throw error; }
  const sessions = new Map();
  const closed = new Promise(resolve => context.once("close", resolve));
  const pipe = {
    closed,
    async send(method, input = {}, id) {
      let timer;
      try { return await Promise.race([this.perform(method, input, id), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Тайм-аут операции удалённого браузера: " + method)), method === "Page.navigate" || method === "Page.navigateToHistoryEntry" ? 12000 : 4500);
      })]); }
      catch (error) {
        if (method === "Page.captureScreenshot" && error.message.includes("Unable to capture screenshot"))
          throw Object.assign(new Error("Страница отрисовывается; прочитайте изображение заново"), { status: 409 });
        throw error;
      } finally { clearTimeout(timer); }
    },
    async perform(method, input = {}, id) {
      if (id) {
        const session = sessions.get(id);
        if (!session) throw Object.assign(new Error("Соединение с документом телефона завершено"), { status: 410 });
        return session.send(method, input);
      }
      if (method === "Browser.close") return context.close();
      if (method === "Target.attachToTarget") {
        for (const page of context.pages()) {
          const session = await context.newCDPSession(page);
          const { targetInfo } = await session.send("Target.getTargetInfo");
          if (targetInfo.targetId !== input.targetId) { await session.detach(); continue; }
          const key = randomBytes(16).toString("hex"); sessions.set(key, session);
          for (const method of ["Page.javascriptDialogOpening", "Fetch.requestPaused"])
            session.on(method, params => pipe.onEvent?.({ method, params, sessionId: key }));
          return { sessionId: key };
        }
        throw Object.assign(new Error("Страница телефона завершена"), { status: 410 });
      }
      return connection.send(method, input);
    },
    async close() { await context.close(); },
  };
  connection.on("Target.targetCreated", params => pipe.onEvent?.({ method: "Target.targetCreated", params }));
  return pipe;
}

export async function runWindowsPhoneBrowser(input = process.stdin, output = process.stdout, options = {}) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const binary = options.binary ?? browserExecutable();
  if (!options.testing && (process.platform !== "win32" || !existsSync(binary))) throw new Error("Специальный компонент браузера телефона не установлен");
  const { PhoneBrowser } = options.PhoneBrowser ? options : await import(new URL("./modules/browser-phone.mjs", import.meta.url));
  const chromium = options.chromium ?? (await import(new URL("./playwright/index.mjs", import.meta.url))).chromium;
  let phone;
  try {
    for await (const text of lines(input)) {
      let result;
      try {
        const request = JSON.parse(text);
        if (request.operation === "configure") {
          if (phone || request.input?.networkMode !== "packet") throw new Error("Браузеру телефона требуется управляемая сеть гостевой системы");
          phone = new PhoneBrowser({ binary, directory: options.directory ?? path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Cage", "PhoneBrowser"),
            language: request.input.language || "en-US", connect: options.connect,
            pipeFactory: (binary, args) => playwrightPhonePipe(chromium, binary, args) });
          result = { ok: true };
        } else {
          if (!phone || request.method !== "POST" || !/^\/phone-browser\/(open|frame|action|close)$/.test(request.path || "")) throw new Error("Недопустимый запрос браузера телефона");
          result = await phone.run(request.path.split("/").at(-1), request.input);
        }
      } catch (error) {
        result = { error: "Операция браузера телефона не завершена; проверьте авторизацию и последнее изображение", code: "phone_browser_error", status: [403, 409, 410, 503].includes(error.status) ? error.status : 400 };
      }
      await new Promise((resolve, reject) => output.write(JSON.stringify(result) + "\n", error => error ? reject(error) : resolve()));
    }
  } finally { await phone?.dispose(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await runWindowsPhoneBrowser().catch(() => { process.exitCode = 1; });
